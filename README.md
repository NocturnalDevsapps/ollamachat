# Static Webhook App

This version of the chatbot uses only HTML, CSS, and JavaScript.

## How it works

- Opens as a static site
- Sends chat requests directly to the n8n production webhook
- Does not use `server.js`

## Configure

Edit `config.js` and update `WEBHOOK_URL` if needed.

## Deploy

You can host this folder on GitHub Pages or any static host.

Important: your n8n webhook must allow CORS from the site where this app is hosted, or browser requests will fail.
