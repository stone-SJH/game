# Phase 1 Task Center

Deploy `index.html`, `app.js` and `app.css` together as the sibling `app/` directory beside `controller/`, or configure `APP_ROOT`. Nginx may serve the static files or proxy them to the controller. There is no frontend build step or embedded secret.

Use the same origin for the page, sessions, `/v1/*` and `/artifacts/*`; the API's `PUBLIC_ORIGIN` must match exactly. The bounded HTTP pilot uses `http://139.224.32.61/` with the controller's explicit `ALLOW_INSECURE_HTTP=true` setting and is not suitable for public accounts. The normal deployment uses trusted HTTPS. The static shell is public; tasks, events and artifacts require login. Browser `Phase1Token` and the editable owner field have been removed.

Register using an operator-issued single-use invitation, or log in. Confirm that creating/reopening tasks reads the owner's server-side list, artifacts download only for that owner, logout removes access, and cancellation displays pending versus confirmed state. User registration does not allocate a worker; the operator must enroll and bind one.

The current view includes task events, artifact images/downloads and final reports. Pause/resume and conversation are still Phase 1 backlog. Deploy the matching controller API, and do not roll back to the old shared-token frontend/API after multi-user data exists.
