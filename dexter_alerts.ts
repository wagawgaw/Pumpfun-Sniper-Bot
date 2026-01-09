import { ENV_PATH, readEnvValues, updateEnvFile } from "./dexter_config";
import { maybeDesktopNotify } from "./dexter_operator";

export interface AlertTargets {
  telegram_bot_token: string;
  telegram_chat_id: string;
  discord_webhook_url: string;
  desktop_notifications: boolean;
}

export class AlertDispatcher {
  constructor(
    readonly targets: AlertTargets,
    private readonly envPath: string = ENV_PATH
  ) {}

  private async postJson(url: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await response.arrayBuffer();
  }

  private resolvedTelegramChatId(): string {
    const configured = (this.targets.telegram_chat_id || "").trim();
    if (configured) return configured;
    const envValues = readEnvValues(this.envPath);
    return (envValues.DEXTER_TELEGRAM_CHAT_ID || "").trim();
  }

  async sendTelegram(title: string, body: string): Promise<boolean> {
    const chat_id = this.resolvedTelegramChatId();
    if (!this.targets.telegram_bot_token || !chat_id) return false;
    const url = `https://api.telegram.org/bot${this.targets.telegram_bot_token}/sendMessage`;
    try {
      await this.postJson(url, { chat_id, text: `${title}\n${body}` });
      return true;
    } catch {
      return false;
    }
  }

  async sendDiscord(title: string, body: string): Promise<boolean> {
    if (!this.targets.discord_webhook_url) return false;
    try {
      await this.postJson(this.targets.discord_webhook_url, { content: `**${title}**\n${body}` });
      return true;
    } catch {
      return false;
    }
  }

  async sendDesktop(title: string, body: string): Promise<boolean> {
    if (!this.targets.desktop_notifications) return false;
    return maybeDesktopNotify(title, body);
  }

  async broadcast(title: string, body: string): Promise<Record<string, boolean>> {
    const [telegram, discord, desktop] = await Promise.all([
      this.sendTelegram(title, body),
      this.sendDiscord(title, body),
      this.sendDesktop(title, body),
    ]);
    return { telegram, discord, desktop };
  }
}

/** Placeholder: full Telegram getUpdates polling is not wired in TS yet (see Python dexter_alerts). */
export class TelegramCommandService {
  private bot_token = "";

  constructor(options: { bot_token?: string } = {}) {
    this.bot_token = (options.bot_token ?? "").trim();
  }

  refresh(bot_token: string): void {
    this.bot_token = (bot_token || "").trim();
  }

  start(): boolean {
    return false;
  }

  stop(_timeoutMs = 2000): void {}
}
