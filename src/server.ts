import { WebSocket, WebSocketServer } from "ws";
import { Character } from "./character";
import { Client, ClientMessage, Player } from "./client";
import axios, { AxiosError } from "axios";
import { ActionHandler, AuthenticateHandler, JoinHandler, PlayerActionHandler, StatusHandler } from "./action";
import { ServerEvent, ErrorEvent, EventError, StatusEvent, PlayerListEvent } from "./event";
import fs from "fs";
import * as https from "node:https";

export interface ServerState {
    title: string,
    owner: string,
    loadedCharacters: number,
    onlinePlayers: number,
    getOnlinePlayers: () => number,
    phase: number,
    requirePassword: boolean,
    tls: boolean
}

const PHASE_LOBBY = 0
const PHASE_DRAFT = 10
const PHASE_SIMULATING = 20

export class Server {
    readonly config;
    readonly characters: Set<Character>;
    private serverState: ServerState;
    clients: Map<WebSocket, Client> = new Map<WebSocket, Client>();
    players: Map<WebSocket, Player> = new Map<WebSocket, Player>();
    private readonly wss: WebSocketServer;
    private actionHandlers: Record<string, ActionHandler>;
    private static instance: Server;

    static getInstance(): Server {
        return this.instance;
    }

    constructor(config: any, characters: Set<Character>) {
        Server.instance = this;
        this.config = config;
        this.characters = characters;

        this.serverState = {
            title: config.title,
            owner: config.owner,
            loadedCharacters: characters.size,
            onlinePlayers: 0,
            getOnlinePlayers: () => { return this.players.size },
            phase: PHASE_LOBBY,
            requirePassword: !!config.password,
            tls: config.tls,
        };

        this.actionHandlers = {
            status: new StatusHandler(this),
            authenticate: new AuthenticateHandler(this),
            join: new JoinHandler(this)
        };

        console.log('Starting WebSocket server...');

        let server;
        let options: any = { host: config.host };
        if (this.config.tls) {
            server = https.createServer({
                key: fs.readFileSync(this.config["private-key"]),
                cert: fs.readFileSync(this.config["certificate"])
            });
            options = { ...options, server };
        } else {
            options = { ...options, port: config.port };
            console.log("TLS is NOT enabled. Clients will not be able to connect due to security features on modern browsers when using HTTPS.")
        }

        this.wss = new WebSocketServer(options);
        this.setupWSServer();

        if (this.config.tls) {
            server?.listen(config.port);
        }

        console.log('Listening on ' + config.host + ":" + config.port + ".");
        console.log('Server ready!');

        if (this.config["publish-server"]) {
            if (! this.config.tls) {
                if (! this.config["force-publish"]) {
                    console.log("Server will not be published to server list because TLS is not enabled. Use 'force-publish' option to bypass this check.");
                    return;
                } else {
                    console.log("Publish TLS check bypassed. Note that clients will not be able to connect when using HTTPS.")
                }
            }
            this.publish();
        }
    }

    private handle(client: Client, data: ClientMessage) {
        try {
            const handler = this.actionHandlers[data.action];
            if (!handler) {
                console.warn("Unknown action:", data.action);
                return;
            }

            if (handler instanceof PlayerActionHandler) {
                const player = this.players.get(client.ws);
                if (!player) {
                    client.send(new ErrorEvent('Unauthenticated.'));
                    return;
                }

                handler.execute(player, data);
            } else {
                handler.execute(client, data);
            }
        } catch (e) {
            if (e instanceof EventError) {
                client.send(new ErrorEvent(e.message));
            } else {
                console.error("Invalid message", e);
            }
        }
    }

    private setupWSServer() {
        this.wss.on('connection', (ws, req) => {
            const client = new Client(ws);
            this.clients.set(ws, client);

            ws.on('close', () => {
                this.clients.delete(ws);
                if (this.players.has(ws)) {
                    console.log(`Player ${this.players.get(ws)?.name} left. (${(this.getServerState().onlinePlayers-1)}/2)`);
                    this.players.delete(ws);
                    this.broadcastPlayerList();
                }
            });

            ws.on('message', (rdata) => {
                if (this.config.debug) {
                    console.log(`Received ${rdata.toString()} from ${client.remoteName}`);
                }

                let message;
                try {
                    message = JSON.parse(rdata.toString());
                } catch (e) {
                    client.send(new ErrorEvent("Malformed request."));
                    return;
                }

                this.handle(client, message);
            });

            client.send(new StatusEvent(this.getServerState()));
        });
    }

    public getPlayerNameList(): string[] {
        let names: string[] = [];
        for (const player of this.players.values()) {
            names.push(player.name);
        }

        return names;
    }

    public broadcastPlayerList() {
        this.broadcast(new PlayerListEvent(this.getPlayerNameList()));
    }

    public broadcast(event: ServerEvent) {
        for (const player of this.players.values()) {
            if (player.isConnectionActive()) {
                player.send(event);
            }
        }
    }

    public getServerState() {
        this.serverState.onlinePlayers = this.serverState.getOnlinePlayers();
        return this.serverState;
    }

    private async publish() {
        console.log("Publishing server to " + this.config["publish-endpoint"]);

        try {
            const res = await axios.post(
                this.config["publish-endpoint"],
                { ip: this.config["publish-address"], port: this.config.port, tls: this.config.tls },
            );
            if (res.data.ok) {
                console.log("Server published to public server list.");
            } else {
                throw new Error("unknown error");
            }
        } catch (e) {
            console.error("Failed to publish to public server list: ",
                e instanceof AxiosError
                    ? e.response?.data : "unknown error");
            console.error("Please confirm publish-address is set to a domain name pointing to your public IP address and the certificate is valid.")
        }
    }
}
