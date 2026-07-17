export interface RoomOwnership {
  ownerOf(roomId: string): string | undefined;
  assign(roomId: string, nodeId: string): void;
  release(roomId: string): void;
}

export class InMemoryRoomOwnership implements RoomOwnership {
  private readonly owners = new Map<string, string>();
  ownerOf(roomId: string): string | undefined { return this.owners.get(roomId); }
  assign(roomId: string, nodeId: string): void { this.owners.set(roomId, nodeId); }
  release(roomId: string): void { this.owners.delete(roomId); }
}
