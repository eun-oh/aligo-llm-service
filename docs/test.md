❯ /btw I created `eun-oh/todo-app-nitrojs` repo that will be used for testing. what should I do next?

/btw how do I create github api key?
/btw I created `eun-oh/todo-app-nitrojs` repo that will be used for testing. what should I do next?

    Now you need to set up the webhook on that repo so it sends PR events to your service.

    1. Create your .env file:
    cp .env.example .env
    Then fill in:
    - GITHUB_TOKEN — the PAT you just created
    - WEBHOOK_SECRET — any random string (e.g., openssl rand -hex 32)
    - OPENROUTER_API_KEY — your OpenRouter key
    - DRY_RUN=true — start in dry-run mode for safety

    2. Expose your local server:

    Since you're on Naver Cloud / local machine, GitHub can't reach localhost:8080. You need a tunnel:
    - ngrok: ngrok http 8080 — gives you a public URL
    - Or deploy the service first, then use that URL

    3. Add the webhook to your repo:

    Go to eun-oh/todo-app-nitrojs → Settings → Webhooks → Add webhook:
    - Payload URL: https://<your-tunnel-or-server>/webhook
    - Content type: application/json
    - Secret: the same WEBHOOK_SECRET from your .env
    - Events: select "Pull requests" only

    4. Start the server and test:
    bun run dev
    Then create a PR on the todo-app repo — you should see the review logged in your terminal (DRY_RUN mode).
