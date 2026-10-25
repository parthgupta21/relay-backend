const Router = require("@koa/router");
const { z } = require("zod");
const { Endpoint } = require("../models");
const auth = require("../middleware/auth");
const requireVerified = require("../middleware/requireVerified");
const validate = require("../middleware/validate");
const { AppError } = require("../utils");

const router = new Router({ prefix: "/endpoints" });
router.use(auth.withApiToken);

const params = z.object({ id: z.string().min(1).max(30) });
const name = z.string().trim().min(1).max(100);
const idempotencyHeader = z.string().trim().toLowerCase().min(1).max(100);

const present = async (endpoints) => {
  const counts = await Endpoint.eventCounts24h(endpoints);
  return endpoints.map((endpoint) =>
    endpoint.present(counts.get(endpoint.id) ?? 0),
  );
};

router.get("/", async (ctx) => {
  const endpoints = await Endpoint.forWorkspace(ctx.state.workspace.id).findAll(
    {
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    },
  );
  ctx.body = await present(endpoints);
});

router.post(
  "/",
  requireVerified,
  validate({
    body: z.object({ name, idempotencyHeader: idempotencyHeader.optional() }),
  }),
  async (ctx) => {
    const workspace = ctx.state.workspace;
    const scoped = Endpoint.forWorkspace(workspace.id);
    if ((await scoped.count()) >= workspace.maxEndpoints)
      throw new AppError("QUOTA_EXCEEDED", 422, "Endpoint limit reached");
    const endpoint = await scoped.create({
      ...ctx.state.body,
      workspaceId: workspace.id,
      slug: Endpoint.generateSlug(),
    });
    ctx.status = 201;
    ctx.body = endpoint.present();
  },
);

router.get("/:id", validate({ params }), async (ctx) => {
  const endpoint = await Endpoint.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  [ctx.body] = await present([endpoint]);
});

router.patch(
  "/:id",
  validate({
    params,
    body: z.object({
      name: name.optional(),
      isActive: z.boolean().optional(),
      idempotencyHeader: idempotencyHeader.nullable().optional(),
    }),
  }),
  async (ctx) => {
    const endpoint = await Endpoint.getOwned(
      ctx.state.workspace.id,
      ctx.state.params.id,
    );
    await endpoint.update(ctx.state.body);
    [ctx.body] = await present([endpoint]);
  },
);

router.delete("/:id", validate({ params }), async (ctx) => {
  const endpoint = await Endpoint.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  await endpoint.destroy();
  ctx.status = 204;
});

router.post("/:id/rotate-slug", validate({ params }), async (ctx) => {
  const endpoint = await Endpoint.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  await endpoint.update({ slug: Endpoint.generateSlug() });
  [ctx.body] = await present([endpoint]);
});

module.exports = router;
