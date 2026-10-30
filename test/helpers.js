process.env.NODE_ENV = "test";
process.env.AUTH_RATE_PER_MINUTE ??= "10000";
process.env.ACCOUNT_DELETE_RATE_PER_MINUTE ??= "10000";
const { after } = require("node:test");
const request = require("supertest");
const app = require("../index");
const { sequelize } = require("../models");
const queue = require("../services/queue");

after(() => queue.close());

const MAILPIT = process.env.MAILPIT_API;
const PASSWORD = "correct-horse-battery";

const resetDatabase = async () => {
  for (const table of [
    "audit_log",
    "delivery_attempts",
    "deliveries",
    "destinations",
    "events",
    "endpoints",
    "sessions",
    "email_tokens",
    "api_tokens",
    "workspaces",
    "users",
  ])
    await sequelize.query(`DELETE FROM ${table}`);
  await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
};

const waitForEmail = async (to, subjectPart) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { messages } = await (await fetch(`${MAILPIT}/messages`)).json();
    const found = messages.find(
      (m) =>
        m.To.some((t) => t.Address === to) && m.Subject.includes(subjectPart),
    );
    if (found) {
      const full = await (await fetch(`${MAILPIT}/message/${found.ID}`)).json();
      await fetch(`${MAILPIT}/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [found.ID] }),
      });
      return full.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no email to ${to} with subject ${subjectPart}`);
};

const tokenFrom = (text) => text.match(/token=([\w-]+)/)[1];

const newAgent = () => request.agent(app.callback());

const signUp = async (email, { verify = true } = {}) => {
  const agent = newAgent();
  await agent.post("/api/v1/auth/register").send({ email, password: PASSWORD });
  if (verify) {
    const token = tokenFrom(await waitForEmail(email, "Verify"));
    await agent.post("/api/v1/auth/verify-email").send({ token });
    await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  }
  return agent;
};

module.exports = {
  app,
  sequelize,
  request,
  PASSWORD,
  resetDatabase,
  waitForEmail,
  tokenFrom,
  newAgent,
  signUp,
};
