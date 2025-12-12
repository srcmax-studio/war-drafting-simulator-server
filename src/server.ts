import { WebSocket, WebSocketServer } from "ws";
import { Character } from "./character";
import { Client, ClientMessage, Player } from "./client";
import axios, { AxiosError } from "axios";
import { ActionHandler, JoinHandler, PlayerActionHandler, StatusHandler } from "./action";
import { ServerEvent, ErrorEvent, EventError } from "./event";

export interface ServerState {
    title: string,
    owner: string,
    loadedCharacters: number,
    onlinePlayers: number,
    getOnlinePlayers: () => number,
    phase: number,
    requirePassword: boolean
}

const PHASE_LOBBY = 0
const PHASE_DRAFT = 10
const PHASE_SIMULATING = 20

export class Server {
    private readonly config;
    private readonly characters: Set<Character>;
    private serverState: ServerState;
    clients: Map<WebSocket, Client> = new Map<WebSocket, Client>();
    players: Map<WebSocket, Player> = new Map<WebSocket, Player>();
    private readonly wss: WebSocketServer;
    private actionHandlers: Record<string, ActionHandler>;

    constructor(config: any, characters: Set<Character>) {
        this.config = config;
        this.characters = characters;

        this.serverState = {
            title: config.title,
            owner: config.owner,
            loadedCharacters: characters.size,
            onlinePlayers: 0,
            getOnlinePlayers: () => { return this.players.size },
            phase: PHASE_LOBBY,
            requirePassword: !!config.password
        };

        this.actionHandlers = {
            status: new StatusHandler(this),
            join: new JoinHandler(this)
        };

        console.log('Starting WebSocket server...');
        this.wss = new WebSocketServer({ host: config.host, port: config.port });
        this.setupWSServer();

        console.log('Listening on ' + config.host + ":" + config.port + ".");
        console.log('Server ready!')

        if (this.config["publish-server"]) {
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
                    this.broadcastStatus();
                }
            });

            ws.on('message', (rdata) => {
                if (this.config.debug) {
                    console.log(rdata.toString());
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

            client.sendRaw(this.serverState);
        });
    }

    public broadcastStatus() {
        this.broadcastRaw(this.getServerState());
    }

    public broadcastRaw(data: any) {
        for (const player of this.players.values()) {
            if (player.isConnectionActive()) {
                player.sendRaw(data);
            }
        }
    }

    public broadcast(event: ServerEvent) {
        this.broadcastRaw(event);
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
                { ip: this.config["publish-ip"], port: this.config.port },
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
            console.error("Please confirm publish-ip is set to your public IP address.")
        }
    }
}
