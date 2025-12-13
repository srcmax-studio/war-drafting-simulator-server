import fs from "fs";
import path from "path";
import { processCharacters } from "./character";
import { Server } from "./server";
import { Logger } from "./utils";

Logger.info('Starting WDS server...')

const config = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "config", "server.json"), "utf8"
));

Logger.info('Loading character data from characters.json...');
const characters = processCharacters(JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "config", "characters/characters.json"), "utf8"
)));
Logger.info("Loaded " + characters.size + " characters.");

new Server(config, characters);
