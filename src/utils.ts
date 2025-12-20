export class Logger {
    static RESET = "\x1b[0m";
    static RED = "\x1b[91m";
    static YELLOW = "\x1b[93m";
    static GRAY = "\x1b[90m";
    static BG_YELLOW = "\x1b[103m";

    private static timestamp(): string {
        return new Date().toISOString();
    }

    static format(text: string, color?: string) {
        return color + text + this.RESET;
    }

    static log(message: string, color?: string): void {
        const timestampedMessage = `[${this.timestamp()}] ${message}`;
        console.log(color ? this.format(timestampedMessage, color) : timestampedMessage);
    }

    static info(message: string): void {
        this.log(`INFO: ${message}`);
    }

    static error(message: string): void {
        this.log(`ERROR: ${message}`, this.RED);
    }

    static warning(message: string): void {
        this.log(`WARNING: ${message}`, this.YELLOW);
    }

    static notice(message: string): void {
        this.log(`NOTICE: ${message}`, this.BG_YELLOW);
    }

    static debug(message: string): void {
        this.log(`DEBUG: ${message}`, this.GRAY);
    }
}

export function shuffle<T>(array: T[]): T[] {
    let currentIndex = array.length;
    let randomIndex: number;

    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]
        ];
    }

    return array;
}
