export function processCharacters(collection: unknown[]): Set<Character> {
    const result = new Set<Character>();

    const uidSet = new Set<string>();
    const nameSet = new Set<string>();

    for (const item of collection) {
        if (!validateCharacter(item)) {
            throw new Error(`Invalid character object detected: ${JSON.stringify(item)}`);
        }

        if (uidSet.has(item.UID)) {
            console.log(`Duplicate character UID ${item.UID} found, skipping...`)
            continue;
        }
        if (nameSet.has(item.名字)) {
            console.log(`Duplicate character name ${item.名字} found, skipping...`)
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

export interface Skill {
    技能名: string;
    技能描述: string;
}

export interface AbilityValues {
    智力: number;
    武力: number;
    政治: number;
    魅力: number;
    统帅: number;
}

export interface Tags {
    标签1?: string;
    标签2?: string;
    标签3?: string;
    [key: string]: string | undefined;
}

export interface Character {
    UID: string;
    ID: string;
    名字: string;
    时代: string;
    地理位置: string;
    费用: number;
    稀有度_数字: number;
    稀有度: string;
    职业: string;
    身份: string;
    描述: string;
    技能: Skill;
    能力值: AbilityValues;
    标签: Tags;
}
