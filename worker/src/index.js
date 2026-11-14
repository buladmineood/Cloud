import { createApp } from './app.js';
import { GraphStore } from './store.js';

let handler;
const app = (env) => {
  // Инстанцията се преизползва между заявките, за да се кешира токенът за Graph.
  handler ??= createApp({ env, store: new GraphStore(env) });
  return handler;
};

export default {
  fetch(request, env, ctx) {
    return app(env)(request, ctx);
  },
  // Ежедневните напомняния по имейл (виж triggers в wrangler.toml).
  scheduled(controller, env, ctx) {
    ctx.waitUntil(app(env).digest().then((r) => console.log('digest', r)));
  },
};
