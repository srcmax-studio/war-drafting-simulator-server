import fs from "fs";
import path from "path";
import { processCharacters } from "./character";
import { Server } from "./server";

console.log('Starting WDS server...')

const config = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "config", "server.json"), "utf8"
));

console.log('Loading character data from characters.json...');
const characters = processCharacters(JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "config", "characters/characters.json"), "utf8"
)));
console.log("Loaded " + characters.size + " characters.");

new Server(config, characters);
