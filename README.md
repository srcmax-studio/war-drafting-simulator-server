# Aeonfront Server

Authoritative Node.js and TypeScript match server for **万世战线 Aeonfront**.

The server accepts simultaneous turn plans over WebSocket, validates every card, cost, target and front capacity through the shared deterministic engine, then broadcasts player-safe views. It owns turn deadlines, reveal order, abilities, front effects, banner stakes, withdrawal and final scoring. No external model participates in gameplay or practice AI decisions.

## Features

- versioned action/event protocol with request ids and monotonic message sequence;
- two-player room, deck selection, ready flow, chat and rematch;
- six-turn authoritative matches and server-side timeout locking;
- reconnect tokens with a configurable recovery window;
- private views that hide opponent hands, deck order and unrevealed cards;
- seeded practice AI that reads only its private view and public board information;
- authoritative catalog, pack-version and custom-deck schema validation;
- reproducible quick, preset, cost-curve and 50,000-game balance simulations;
- HTTP `GET /health` on the same port as WebSocket;
- optional TLS and public server-list publication;
- optional post-game generation configuration, disabled by default and isolated from rules.

## Setup

```bash
git submodule update --init --recursive
npm install
cp config/server.example.json config/server.json
npm run dev
```

Local development defaults to `ws://127.0.0.1:3001` without TLS. Production browser deployments should enable TLS and use valid key/certificate paths. `config/server.json` is ignored and must never contain committed credentials.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:replay
npm run test:ai
npm run test:cards
npm run simulate:balance:quick
npm run build
```

The integration suite drives two real WebSocket clients through a full six-turn match, verifies private information, reconnects a player, completes a practice match and replays its event log to the identical final state.

## Protocol flow

Connect, authenticate when required, join, submit a versioned legal twelve-card deck, ready, then exchange `submitTurn`, `undoTurn`, `lockTurn`, `raiseBanner`, `withdraw`, `requestSync`, `requestRematch`, `chatMessage` and `pong` actions. Every message uses `aeonfront/2`. Deck payloads include schema, catalog and pack versions; the server resolves all rules from canonical card IDs.
