import { Logger } from "./utils";

import { Character } from "./common/common";

export function processCharacters(collection: unknown[]): Set<Character> {
    const result = new Set<Character>();

    const uidSet = new Set<string>();
    const nameSet = new Set<string>();

    for (const item of collection) {
        if (!validateCharacter(item)) {
            throw new Error(`Invalid character object detected: ${JSON.stringify(item)}`);
        }

        if (uidSet.has(item.UID)) {
            Logger.warning(`Duplicate character UID ${item.UID} found, skipping...`)
            continue;
        }
        if (nameSet.has(item.名字)) {
            Logger.warning(`Duplicate character name ${item.名字} found, skipping...`)
            continue;
        }

        uidSet.add(item.UID);
        nameSet.add(item.名字);

        result.add(item);
    }

    return result;
}

function validateCharacter(obj: any): obj is Character {
    const requiredFields = [
        "UID", "ID", "名字", "时代", "地理位置", "费用",
        "稀有度_数字", "稀有度", "职业", "身份", "描述",
        "技能", "能力值", "标签"
    ];

    return requiredFields.every(f => obj && f in obj);
}

