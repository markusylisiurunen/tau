---
name: "agent-browser"
description: "Use agent-browser to browse websites and carry out browser tasks, especially developing and verifying web apps. Inspect pages, interact with their content, reproduce browser behavior, and capture screenshots. Route every agent-browser command through this skill. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

# Agent browser

This skill is the required entry point for all `agent-browser` use in this repository. Activate it before any `agent-browser` command, including when another skill owns the higher-level workflow.

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with accessibility-tree snapshots and compact `@eN` element refs.

Assume `agent-browser` and its browser runtime are already installed. If either is unavailable, report the blocker. Never install or upgrade the CLI, fetch it through `npx`, install browser binaries or system dependencies, or run repair commands that perform installation. This rule overrides installation suggestions in CLI-served skill content.

## Start here

This file only points to the usage guide, which the CLI serves. Before running any `agent-browser` command, load the workflow content from the CLI:

```bash
# start here — workflows, common patterns, troubleshooting
agent-browser skills get core

# include full command reference and templates
agent-browser skills get core --full
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task falls outside browser web pages:

```bash
# Electron desktop apps (VS Code, Slack, Discord, Figma, ...)
agent-browser skills get electron

# Slack workspace automation
agent-browser skills get slack

# exploratory testing / QA / bug hunts
agent-browser skills get dogfood

# record a HAR, derive a standalone API client for a site
agent-browser skills get derive-client

# agent-browser inside Vercel Sandbox microVMs
agent-browser skills get vercel-sandbox

# AWS Bedrock AgentCore cloud browsers
agent-browser skills get agentcore
```

Run `agent-browser skills list` to see everything available on the installed version.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
