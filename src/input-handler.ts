export class InputHandler {
  private autoRespond: boolean;

  constructor(autoRespond: boolean = true) {
    this.autoRespond = autoRespond;
  }

  shouldAutoRespond(): boolean {
    return this.autoRespond;
  }

  getAutoResponse(): string {
    return 'This is a non-interactive session. Please proceed with your best judgment.';
  }
}
