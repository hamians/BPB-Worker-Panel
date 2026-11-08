import worker from '../_worker.js';

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/') {
      return Response.redirect(new URL('/login', request.url), 302);
    }
    return worker.fetch(request, env, ctx);
  }
};
