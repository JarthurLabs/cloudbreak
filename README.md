# Cloudbreak

I wanted to make protecting a cloud service feel like a decision you could see.

Cloudbreak is a three-minute browser game about keeping a futuristic city online while different attacks arrive through its Internet connections. The buildings represent cloud services. Cyan traffic represents customers. Your job is to stop the threats without shutting out too many of the people the city is supposed to serve.

I'm Nicholas. I built this with Codex, directing the gameplay, visuals, onboarding, balance, and sound through repeated playthroughs and reviews. Codex handled implementation, automated checks, and gameplay captures.

## Release in progress

The public browser deployment and a 4K demonstration are being prepared. The finished demonstration and verified playable link will appear here when ready. This initial repository contains the game and its build story; it does not yet claim that the public game is live.

## Three threats, three decisions

- **Key check** refuses coral probes with invalid credentials. A working key can still belong to an attacker.
- **Slow flow** limits an amber swarm's volume. Customers share the same allowance, and some hostile traffic can still pass.
- **Close bridge** stops violet carriers by isolating the route. It also stops customers, so reopen when the route is clear.

Protect the city for three minutes and serve at least 75 percent of customers. Click a defense directly beneath any building. Later attacks overlap across districts. Pause provides music, volume, and reduced-motion settings. The selected original score is **Firewall Drive**.

## Why I built it

My experience with software-as-a-service implementation, documentation, onboarding, and troubleshooting makes me pay attention to what a setting does to the workflow around it. I wanted the cost of a security decision to be visible too: a city can survive the attacks and still fail if too many customers are turned away.

[How I built it](docs/HOW_IT_WAS_BUILT.md) · [Cloud security concepts](docs/CLOUD_SECURITY.md) · [Hosting design and limits](docs/HOSTING.md)

## Run it locally

With Node.js 24.19.0 installed, install the dependencies and start the game:

```sh
npm ci
npm run dev
```

Open [the local game](http://127.0.0.1:5310). To check and build the project:

```sh
npm test
npm run build
```

`npm start` serves the built frontend and gateway locally. `npm run start:cloud` is the separate hosted entrypoint described in the hosting guide. A static host alone cannot run the gateway.

## What is real

The Node server sends synthetic HTTP requests through the game's own authentication, rate-limit, and isolation middleware. Actual responses drive the counters and animations. The gateway does not receive friendly or hostile labels before deciding. The Inspect panel exposes measured request evidence.

The city, threats, credits, and integrity are a teaching model. This is not a production Azure or Amazon Web Services environment, and the game does not send attacks to outside systems. Automated checks establish behavior, not learning effectiveness or production security experience.

Interactive geometry and sound were made for the project. [The background provenance](public/art/PROVENANCE.md) identifies the generated city image separately. Source licensing remains undecided. Dependencies retain their own licenses.

You can also play [Ghost Protocol](https://ghost-protocol-b74p.onrender.com), my maze game about copied credentials and knowing which access to revoke.
