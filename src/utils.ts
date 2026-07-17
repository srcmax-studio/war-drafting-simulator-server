export class Logger {
  private static write(level: 'INFO' | 'WARN' | 'DEBUG', message: string): void {
    const record = JSON.stringify({ timestamp: new Date().toISOString(), level, message });
    if (level === 'WARN') console.error(record);
    else console.log(record);
  }

  static info(message: string): void { this.write('INFO', message); }
  static warning(message: string): void { this.write('WARN', message); }
  static debug(message: string): void { this.write('DEBUG', message); }
}
