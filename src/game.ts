import { Server } from "./server";
import { Logger, shuffle } from "./utils";
import { DISCARD_MAX_INITIATIVE, DISCARD_MAX_PASSIVE, Player } from "./client";
import {
    DraftEvent,
    GameStartEvent,
    PlayerDeckUpdateEvent,
    SimulationStartEvent,
    SimulationStreamEvent
} from "./event";

import {
    Character,
    DRAFT_STAGE_INIT,
    DRAFT_STAGE_PASSIVE,
    DRAFT_STAGE_PASSIVE_DISCARD,
    PHASE_DRAFT, PHASE_SIMULATING,
    PlayerDeck, POSITIONS
} from "./common/common";
import fs from "fs";
import path from "path";

const DRAFT_DURATION_PASSIVE_DISCARD = 30000;
const DRAFT_DURATION_INIT = 60000;
const DRAFT_DURATION_PASSIVE = 45000;

export class Game {
    private static readonly PACK_SIZE = 5;

    private server: Server;
    private deck: Character[];
    private currentPack: Character[] = [];
    private initiative: Player | null = null;
    private draftStage: number = -1;
    private draftRound : number = 0;
    private timeout: NodeJS.Timeout | null = null;
    private skipInitSwitch: boolean = false;

    constructor(server: Server) {
        this.server = server;
        this.deck = shuffle(Array.from(server.characters));

        for (const player of server.players.values()) {
            player.initDiscardRemaining = DISCARD_MAX_INITIATIVE;
            player.passiveDiscardRemaining = DISCARD_MAX_PASSIVE;

            player.deck = new PlayerDeck(player.name);
        }

        this.initiative = Array.from(server.players.values())[Math.floor(Math.random() * 2)];
        this.server.setPhase(PHASE_DRAFT);

        this.server.broadcast(new GameStartEvent(this.initiative.name));
        Logger.info('Both player ready. Game starts.');

        this.newDraftRound(true);
    }

    public createTimeout(cb: () => void, duration: number) {
        this.timeout = setTimeout(cb, duration);
    }

    public clearTimeout() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
    }

    public getDraftStage() {
        return this.draftStage;
    }

    public terminate() {
        this.clearTimeout();
    }

    public getInitiativePlayer(): Player {
        return <Player>this.initiative;
    }

    public getOtherPlayer(player: Player): Player | null {
        for (const other of this.server.players.values()) {
            if (other !== player) {
                return other;
            }
        }

        return null;
    }

    public switchInitiativePlayer() {
        if (this.skipInitSwitch) {
            this.skipInitSwitch = false;
            return;
        }

        this.initiative = this.getPassivePlayer();
    }

    public getPassivePlayer(): Player {
        return <Player>this.getOtherPlayer(this.getInitiativePlayer());
    }

    private startSimulation() {
        this.server.getServerState().phase = PHASE_SIMULATING;
        this.server.broadcast(new SimulationStartEvent());
        this.simulate();
    }

    private newPack() {
        if (this.deck.length < Game.PACK_SIZE) {
            Logger.warning("Deck ran out of cards! Cannot draw a full pack.");

            const remainingCards = this.deck.splice(0, this.deck.length);
            this.currentPack = remainingCards;
            return remainingCards;
        }
        this.currentPack = this.deck.splice(0, Game.PACK_SIZE);

        if (this.getPassivePlayer()?.passiveDiscardRemaining ?? 0 > 0) {
            this.startPassiveDiscardStage();
        } else {
            this.startInitiativeStage();
        }
    }

    public newDraftRound(firstRound: boolean = false) {
        if (this.initiative?.deck?.isComplete()) {
            this.startSimulation();
            return;
        }

        if (! firstRound) {
            this.switchInitiativePlayer();
        }

        this.draftRound ++;
        this.newPack();
    }

    private makeDraftEvent(draftStage: number, duration: number): DraftEvent {
        this.draftStage = draftStage;

        return new DraftEvent(this.draftRound, draftStage, this.getInitiativePlayer().name, this.currentPack ?? [], duration);
    }

    private startPassiveDiscardStage() {
        this.server.broadcast(this.makeDraftEvent(DRAFT_STAGE_PASSIVE_DISCARD,
            this.draftRound === 1 ? DRAFT_DURATION_PASSIVE_DISCARD + 8 : DRAFT_DURATION_PASSIVE_DISCARD));

        this.createTimeout(() => this.settlePassiveDiscard(), DRAFT_DURATION_PASSIVE_DISCARD);
    }

    private startInitiativeStage() {
        this.server.broadcast(this.makeDraftEvent(DRAFT_STAGE_INIT, DRAFT_DURATION_INIT));

        this.createTimeout(() =>
            this.settleSelect(this.getInitiativePlayer(), this.currentPack[0].名字, () => this.startPassiveStage()), DRAFT_DURATION_INIT);
    }

    public startPassiveStage() {
        this.server.broadcast(this.makeDraftEvent(DRAFT_STAGE_PASSIVE, DRAFT_DURATION_PASSIVE));

        this.createTimeout(() =>
            this.settleSelect(this.getPassivePlayer(), this.currentPack[0].名字, () => this.newDraftRound()), DRAFT_DURATION_PASSIVE);
    }

    public settlePassiveDiscard(discard: boolean = false) {
        if (discard) {
            this.getPassivePlayer().passiveDiscardRemaining --;
            this.skipInitSwitch = true;

            this.newDraftRound();
        } else {
            this.startInitiativeStage();
        }
    }

    public settleSelect(player: Player, characterName: string, cb: () => void) {
        for (const character of this.currentPack) {
            if (character.名字 === characterName) {
                player.deck?.addCharacter(character);

                this.broadcastDecks();

                this.currentPack = this.currentPack.filter(char => {
                    return char !== character;
                });
                cb();
            }
        }
    }

    public broadcastDecks() {
        let decks: PlayerDeck[] = [];
        for (const player of this.server.getPlayerList()) {
            if (! player.deck) {
                continue;
            }

            decks.push(player.deck);
        }

        this.server.broadcast(new PlayerDeckUpdateEvent(decks));
    }

    public async simulate() {
        const promptContent: string = fs.readFileSync(
            path.resolve(process.cwd(), "config/prompt", "prompt.txt"), "utf8"
        );

        const player1 = this.getInitiativePlayer().deck;
        const player2 = this.getPassivePlayer().deck;
        let player1Deck: any = {}; let player2Deck: any = {};
        for (const pos of POSITIONS) {
            player1Deck[pos.key] = player1?.getPosition(pos.key);
            player2Deck[pos.key] = player2?.getPosition(pos.key);
        }

        const response = await this.server.ai.models.generateContentStream({
            model: this.server.config["gemini-model"],
            contents: promptContent.replace("##DECKDATA##", JSON.stringify({
                player1: player1Deck,
                player2: player2Deck
            })),
        });

        for await (const chunk of response) {
            if (chunk.candidates) {
                for (const part of chunk.candidates[0].content?.parts ?? []) {
                    if (part.text != undefined && part.text) {
                        this.server.broadcast(new SimulationStreamEvent(part.text
                            .replace("P1阵营", this.getInitiativePlayer().name + "(P1)阵营")
                            .replace("P1", this.getInitiativePlayer().name + "(P1)阵营")
                            .replace("P2阵营", this.getPassivePlayer().name + "(P2)阵营")
                            .replace("P2", this.getPassivePlayer().name + "(P2)阵营")
                        ));
                    }
                }
            }
        }
    }
}
