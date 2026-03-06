/**
 * SSE event broadcaster for real-time dashboard updates.
 *
 * Manages connected SSE clients and broadcasts events to all of them.
 * Dead clients (write errors) are automatically removed.
 */
export class SSEBroadcaster {
  private clients = new Map<string, WritableStreamDefaultWriter>();

  /**
   * Register a new SSE client. If a client with the same id already exists,
   * it is replaced (the old writer is not closed — caller is responsible).
   */
  addClient(id: string, writer: WritableStreamDefaultWriter): void {
    this.clients.set(id, writer);
  }

  /**
   * Remove a client by id. No-op if the client doesn't exist.
   */
  removeClient(id: string): void {
    this.clients.delete(id);
  }

  /**
   * Broadcast an SSE event to all connected clients.
   * Clients that fail to receive the message are automatically removed.
   *
   * @param event - SSE event name (appears as `event: <name>` in the stream)
   * @param data  - Payload, serialized as JSON in the `data:` field
   */
  broadcast(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [id, writer] of this.clients) {
      writer.write(message).catch(() => {
        // Client connection is dead — remove it
        this.clients.delete(id);
      });
    }
  }

  /**
   * Returns the number of currently connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }
}
