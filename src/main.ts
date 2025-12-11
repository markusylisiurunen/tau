#!/usr/bin/env node
import { ChatApp } from "./app.js";
import { personas } from "./personas.js";

const app = new ChatApp({ personas });

try {
  await app.start();
} catch (err) {
  app.stop();
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
