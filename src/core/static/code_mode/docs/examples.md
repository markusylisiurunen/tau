# Code Mode examples

## Find release notes for the installed Node version

```js
import { bash, printText } from "@tau/core";
import { search } from "@tau/web";

const version = (await bash.text("node --version")).trim();
const { results, notices } = await search(`Node.js ${version} release notes`, {
  includeDomains: ["nodejs.org"],
  numResults: 3,
});
for (const { title, url } of results) printText(`${title}: ${url}`);
for (const { message } of notices) printText(message);
```

## Edit two related lines and show the diff

```js
import { bash, files, printText } from "@tau/core";

await files.edit("docs/quickstart.md", [
  { oldText: "npm run dev", newText: "npm start" },
  { oldText: "Open port 3000", newText: "Open port 4000" },
]);
printText(await bash.text("git diff -- docs/quickstart.md"));
```

## Ask a model about a screenshot

```js
import { input, printText } from "@tau/core";
import { chat } from "@tau/models";

const result = await chat([
  { role: "user", content: [
    { type: "text", text: "What error is visible in the screenshot?" },
    { type: "image", path: input.screenshot },
  ] },
], { model: "google/gemini-3.8-flash" });

if (result.status === "complete") printText(result.answer);
else printText(`No answer: ${result.status}`);
```
