const Router = require("@koa/router");
const { z } = require("zod");
const { Endpoint, Destination } = require("../models");
const auth = require("../middleware/auth");
const requireVerified = require("../middleware/requireVerified");
const validate = require("../middleware/validate");
const { checkUrl, SsrfError } = require("../services/ssrf");
const { AppError } = require("../utils");

const router = new Router();
router.use(auth);

const params = z.object({ id: z.string().min(1).max(30) });
const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048),
  customHeaders: z.record(z.string().min(1).max(100), z.string().max(1000)),
  timeoutMs: z.number().int().min(1000).max(30000),
};

const assertUrlAllowed = (url) =>
  checkUrl(url).catch((err) => {
    if (!(err instanceof SsrfError)) throw err;
    throw new AppError(
      "VALIDATION_FAILED",
      422,
      "Destination URL is not allowed",
      [{ path: ["url"], message: err.message }],
    );
  });

router.get("/endpoints/:id/destinations", validate({ params }), async (ctx) => {
  const endpoint = await Endpoint.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  const destinations = await Destination.findAll({
    where: { endpointId: endpoint.id },
    order: [["id", "ASC"]],
  });
  ctx.body = destinations.map((destination) => destination.present());
});

router.post(
  "/endpoints/:id/destinations",
  requireVerified,
  validate({
    params,
    body: z.object({
      name: fields.name,
      url: fields.url,
      customHeaders: fields.customHeaders.optional(),
      timeoutMs: fields.timeoutMs.optional(),
    }),
  }),
  async (ctx) => {
    const workspace = ctx.state.workspace;
    const endpoint = await Endpoint.getOwned(workspace.id, ctx.state.params.id);
    if (
      (await Destination.count({ where: { endpointId: endpoint.id } })) >=
      workspace.maxDestinations
    )
      throw new AppError("QUOTA_EXCEEDED", 422, "Destination limit reached");
    await assertUrlAllowed(ctx.state.body.url);
    const signingSecret = Destination.generateSecret();
    const destination = await Destination.create({
      ...ctx.state.body,
      endpointId: endpoint.id,
      signingSecret: Destination.encryptSecret(signingSecret),
    });
    ctx.status = 201;
    ctx.body = { ...destination.present(), signingSecret };
  },
);

router.patch(
  "/destinations/:id",
  validate({
    params,
    body: z.object({
      name: fields.name.optional(),
      url: fields.url.optional(),
      customHeaders: fields.customHeaders.nullable().optional(),
      timeoutMs: fields.timeoutMs.optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  async (ctx) => {
    const destination = await Destination.getOwned(
      ctx.state.workspace.id,
      ctx.state.params.id,
    );
    const { url } = ctx.state.body;
    if (url && url !== destination.url) await assertUrlAllowed(url);
    await destination.update(ctx.state.body);
    ctx.body = destination.present();
  },
);

router.delete("/destinations/:id", validate({ params }), async (ctx) => {
  const destination = await Destination.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  await destination.destroy();
  ctx.status = 204;
});

router.post(
  "/destinations/:id/rotate-secret",
  validate({ params }),
  async (ctx) => {
    const destination = await Destination.getOwned(
      ctx.state.workspace.id,
      ctx.state.params.id,
    );
    const signingSecret = Destination.generateSecret();
    await destination.update({
      signingSecret: Destination.encryptSecret(signingSecret),
    });
    ctx.body = { id: destination.publicId, signingSecret };
  },
);

module.exports = router;
