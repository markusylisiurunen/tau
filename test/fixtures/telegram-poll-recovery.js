import { startTelegramAdapter } from "../../dist/core/telegram/adapter.js";

const outage = Promise.withResolvers();
const bots = await Promise.all(
  ["first", "second"].map(async (botId) => {
    const resumed = Promise.withResolvers();
    let polls = 0;
    const adapter = await startTelegramAdapter({
      botId,
      projects: {},
      sessionManager: { listSessions: () => [], onEvent: () => () => {} },
      api: {
        getMe: async () => ({ username: botId }),
        setCommands: async () => {},
        async getUpdates() {
          polls++;
          if (polls === 1) return outage.promise;
          if (polls === 2) return [];
          resumed.resolve();
          return new Promise(() => {});
        },
      },
    });
    return { adapter, resumed: resumed.promise };
  }),
);

outage.reject(new Error("transient poll failure"));
await Promise.all(bots.map((bot) => bot.resumed));
await Promise.all(bots.map((bot) => bot.adapter.close()));
