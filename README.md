# Aeonfront Server

Authoritative Node.js and TypeScript match server for **万世战线 Aeonfront**.

The server accepts simultaneous turn plans over WebSocket, validates every card, cost, target and front capacity through the shared deterministic engine, then broadcasts player-safe views. It owns turn deadlines, reveal order, abilities, front effects, banner stakes, withdrawal and final scoring. No external model participates in gameplay or practice AI decisions.

## Features

- versioned lobby, room, matchmaking and game protocol with request ids and per-connection monotonic message sequence;
- many simultaneous two-player rooms with isolated settings, chat, deck selection, ready flow and rematch;
- quick matchmaking with duplicate protection, confirmation deadlines, decline and disconnect cleanup;
- six-turn authoritative matches and server-side timeout locking;
- independent seeds, event sequences and timers for concurrent games;
- rotating reconnect tokens with lobby, room and game recovery;
- private views that hide opponent hands, deck order and unrevealed cards;
- seeded practice AI that reads only its private view and public board information;
- authoritative catalog, pack-version and custom-deck schema validation;
- reproducible quick, preset, cost-curve and 50,000-game balance simulations;
- bounded connection, chat and room-creation rates, payload size, backpressure and idle cleanup;
- in-memory store, room ownership and message-bus interfaces for future distributed adapters;
- HTTP `GET /health`, `GET /ready` and optional `GET /metrics` on the WebSocket port;
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
npm run test:lobby
npm run test:rooms
npm run test:matchmaking
npm run test:concurrent-games
npm run test:reconnect
npm run test:load
npm run test:security
npm run test:replay
npm run test:ai
npm run test:cards
npm run simulate:balance:quick
npm run build
```

The suites drive real WebSocket clients through the lobby, isolated rooms, quick matching, a full six-turn match, reconnect, practice AI and deterministic replay. The load baseline verifies 100 connections, 50 lobby users, 25 rooms and 20 simultaneous games without cross-room messages or timer conflicts.

## Protocol flow

Connect, authenticate when required, establish a session with `join`, then enter the lobby. From there create or join a room, or enter quick matchmaking. Room members select a versioned legal twelve-card deck and use `setReady`; game actions are scoped by `gameId`. Every message uses `aeonfront/3`. The server resolves all rules from canonical card IDs and never broadcasts a room or private game view outside its membership.
