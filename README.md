# Setu • Safe Internet & Pediatric Caretaker Sanctuary 🌿

> **Where curiosity blooms safely.**  
> A child-safe search engine, real-time pediatric developmental safety gate, and caretaker oversight dashboard powered by Google Gemini and peer-reviewed clinical research.

[![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%26%20Auth-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Gemini API](https://img.shields.io/badge/Google-Gemini%20Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Architecture & Design](#-architecture--design)
- [Technology Stack](#-technology-stack)
- [Project Directory Structure](#-project-directory-structure)
- [Prerequisites](#-prerequisites)
- [Quickstart (Local Development)](#-quickstart-local-development)
- [Environment Variables](#-environment-variables)
- [Deployment Guide](#-deployment-guide)
  - [Deploy to Render](#1-deploy-to-render)
  - [Deploy to Google Cloud Run / AI Studio](#2-deploy-to-google-cloud-run--ai-studio)
  - [Deploy with Docker](#3-deploy-with-docker)
  - [Deploy to Linux VPS (PM2 + Nginx)](#4-deploy-to-linux-vps-pm2--nginx)
- [API & Route Reference](#-api--route-reference)
- [Security & Access Control](#-security--access-control)
- [Testing & Quality Assurance](#-testing--quality-assurance)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🌟 Overview

**Setu** (meaning *"bridge"* in Sanskrit) bridges a child's natural curiosity with safe, age-appropriate digital discovery. Rather than presenting internet search as a punitive black box, Setu acts as an educational and developmental sanctuary for children ages **5 through 17**.

Whenever a minor searches:
1. **Real-time Safety Assessment**: The search query is evaluated against both an AI classification engine (Google Gemini) and a multi-tier deterministic heuristic engine.
2. **Age-Maturity Curation**: Educational websites, interactive tools, and audio/visual resources are tailored strictly to the child's developmental tier (Early Childhood 5–8, Middle School 9–13, High School/Teens 14–17).
3. **Pediatric Evidence Grounding**: High-risk or boundary inquiries are linked directly to peer-reviewed clinical literature (via live **PubMed NCBI E-Utilities** or our curated pediatric research catalog) from leading medical journals (*Pediatrics*, *Journal of Adolescent Health*, *The Lancet*, *The Journal of Sex Research*, etc.).
4. **Caretaker Oversight**: Parent monitoring is protected behind a **Child Security PIN**. Search logs, safety rationales, and medical citations are strictly isolated by account profile.

---

## 🚀 Key Features

### 🛡️ 1. Real-Time Pediatric Safety Verdicts
- **🌿 Allowed (Flourishing)**: Completely safe, constructive inquiries receive high-yield educational links, interactive models, and audio/video resources.
- **🌾 Risky (Guidance Recommended)**: Sensitive topics (mental health, social media pressure, digital piracy) are answered with developmental context, age-calibrated explanations, and constructive alternatives.
- **🛡️ Shielded (Harmful Content Blocked)**: Prohibited categories (sexually explicit content, self-harm, weapons, illicit substances, cyberbullying) are safely blocked before exposure with developmental reasoning.

### 🔬 2. Peer-Reviewed Academic Evidence Grounding
- Automated citation discovery using **NCBI PubMed E-Utilities** with Boolean pediatric search queries.
- Curated clinical research catalog for sensitive youth risk topics (PMID, Authors, Journal, Year, Abstract Snippet, and Clinical Key Takeaway).
- Resilient rate-limit and network fallback mechanisms.

### 🔒 3. Child Protection & Parent PIN Sanctuary
- Children cannot navigate into parent oversight controls without unlocking the tactile 4–6 digit **Security PIN**.
- Searching in child view automatically re-locks caretaker controls to prevent accidental exposure.

### 👥 4. Strict Multi-Account Isolation
- Each caretaker account (registered via Email/Password or Google/Firebase OAuth) has a **completely isolated history log**.
- No query leakage across user profiles or family accounts.
- Zero-leak audit logging with individual CSV and JSON data export.

### 🎨 5. Tactile Organic Design System
- Warm, tranquil earth-tone aesthetic (*Fraunces* serif, *Plus Jakarta Sans*, and *Outfit* typography).
- Interactive tactile pebbles, simulated browser chrome window, and responsive mobile-first layouts.

---

## 🏗️ Architecture & Design

```
                     +---------------------------------------+
                     |           Client Browser              |
                     |   (Child Search / Parent Dashboard)   |
                     +-------------------+-------------------+
                                         |
                                HTTPS / Cookies
                                         |
                                         v
                     +---------------------------------------+
                     |         Express Server (Node.js)      |
                     |  - Cookie-Parser (Signed Sessions)    |
                     |  - Parent PIN Verification Guard      |
                     |  - Account Scoping Middleware         |
                     +-----+---------------------------+-----+
                           |                           |
            +--------------v--------------+     +------v--------------------+
            |      AI & Safety Engine     |     |     Storage & Persistence |
            |  - Google Gemini Flash SDK  |     |  - Local JSON Store       |
            |  - Pediatric Rule Classifier|     |  - Firebase Cloud Firestore|
            |  - NCBI PubMed API Client   |     |  - Scrypt Password Hasher |
            +-----------------------------+     +---------------------------+
```

---

## 💻 Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Runtime & Server** | [Node.js](https://nodejs.org/) (v20+ LTS), [Express.js](https://expressjs.com/) (v4.21) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) (v5.7) |
| **Development & Build** | [tsx](https://github.com/privatenumber/tsx) (Zero-config TS runner), [esbuild](https://esbuild.github.io/) (High-speed bundler) |
| **Templating** | [EJS](https://ejs.co/) (Embedded JavaScript Templates) |
| **Database & Cloud** | [Google Cloud Firestore](https://firebase.google.com/docs/firestore), [Firebase Auth](https://firebase.google.com/docs/auth) |
| **AI / Machine Learning** | Google Gemini 2.5 Flash / 3.1 Flash Lite via [`@google/genai`](https://www.npmjs.com/package/@google/genai) |
| **Medical Literature** | [NCBI Entrez E-Utilities API](https://www.ncbi.nlm.nih.gov/books/NBK25501/) (PubMed) |
| **Styling & Assets** | Custom CSS3 Garden Theme, Semantic HTML5, SVG Icons, DiceBear Bottts Avatars |

---

## 📁 Project Directory Structure

```
├── .env.example              # Sample environment configuration template
├── .gitignore                # Git ignore rules for node_modules, dist, secrets
├── bun.lock                  # Lockfile for Bun package manager
├── package.json              # NPM dependencies, scripts, and package metadata
├── render.yaml               # Render Infrastructure-as-Code deploy blueprint
├── tsconfig.json             # TypeScript compiler configuration
├── metadata.json             # Applet capabilities and runtime metadata
│
├── server.ts                 # Main Express web server & route handlers
├── storage.ts                # Account management, sessions, and query logging
├── firebaseConfig.ts         # Firebase SDK initialization & error handling
├── firebase-blueprint.json   # Intermediate Schema representation for Firestore
├── firestore.rules           # Attribute-Based Access Control security rules
├── security_spec.md          # Zero-trust payload tests & security documentation
│
├── data/
│   └── setu_store.json       # Persistent file-based database store
│
├── static/
│   └── style.css             # Unified organic sanctuary design system stylesheet
│
└── views/                    # EJS views and server-rendered templates
    ├── index.ejs             # Child safe search explorer & results view
    ├── dashboard.ejs         # Caretaker sanctuary metrics & activity logs
    ├── login.ejs             # Caretaker email & Google authentication view
    ├── register.ejs          # New caretaker account creation view
    ├── parent-login.ejs      # Security PIN unlock gate for dashboard access
    └── setup-pin.ejs         # First-time PIN setup view
```

---

## ⚙️ Prerequisites

Before running the application locally or deploying to production, ensure you have:

- **Node.js**: `v20.0.0` or higher ([Download Node.js](https://nodejs.org/))
- **npm** (comes with Node.js) or **bun** / **yarn** / **pnpm**
- **Google Gemini API Key**: Obtain a free or paid API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- *(Optional)* **Firebase Project**: Only needed if deploying live Firestore rules or Google Firebase Auth

---

## ⚡ Quickstart (Local Development)

### 1. Clone the repository
```bash
git clone https://github.com/your-username/setu-safe-internet.git
cd setu-safe-internet
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
Create a `.env` file in the project root based on `.env.example`:
```bash
cp .env.example .env
```
Open `.env` and fill in your values:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
COOKIE_SECRET=create_a_random_secure_32_character_string
APP_URL=http://localhost:3000
```

### 4. Run the development server
```bash
npm run dev
```
The server will boot with live TypeScript compilation:
```
Setu Safe Browser Server running on http://0.0.0.0:3000
```
Open your browser and navigate to: **`http://localhost:3000`**

### 5. Build for production locally
```bash
npm run build
npm start
```

---

## 🔐 Environment Variables

| Variable Name | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `GEMINI_API_KEY` | **Yes** | `AIzaSy...` | Authenticates requests with the `@google/genai` SDK for real-time query risk assessment |
| `COOKIE_SECRET` | **Yes** | `super-secret-salt-32-chars` | Signs HTTP session and PIN authentication cookies against tampering |
| `PORT` | No | `3000` | Port on which the Express server listens |
| `APP_URL` | No | `http://localhost:3000` | Canonical public URL used for OAuth redirects and base links |
| `GOOGLE_CLIENT_ID` | Optional | `xxx.apps.googleusercontent.com` | Google OAuth 2.0 Web Client ID for native Google Sign-In |
| `GOOGLE_CLIENT_SECRET` | Optional | `GOCSPX-xxxx` | Google OAuth 2.0 Client Secret |

---

## 🚢 Deployment Guide

### 1. Deploy to Render

Setu includes a pre-configured `render.yaml` file for 1-click deployments:

1. Push your code to a GitHub or GitLab repository.
2. Sign in to your [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** > **Blueprint**.
4. Connect your repository. Render will automatically detect `render.yaml`.
5. In the environment variables prompt, enter your `GEMINI_API_KEY`.
6. Click **Apply**. Render will run:
   ```bash
   npm install && npm run build
   npm start
   ```
7. Your app will be live at `https://your-service-name.onrender.com`.

---

### 2. Deploy to Google Cloud Run / AI Studio

Setu is architected for direct execution in Google Cloud Run environments:

1. Install and authenticate the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install):
   ```bash
   gcloud auth login
   gcloud config set project YOUR_GCP_PROJECT_ID
   ```
2. Build and deploy directly using Cloud Run source build:
   ```bash
   gcloud run deploy setu-safe-internet \
     --source . \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars GEMINI_API_KEY="your_gemini_api_key",COOKIE_SECRET="your_cookie_secret"
   ```
3. Cloud Run will output your live URL (e.g. `https://setu-safe-internet-xxx.a.run.app`).

---

### 3. Deploy with Docker

A production Dockerfile can be added to containerize the app:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/views ./views
COPY --from=builder /app/static ./static
COPY --from=builder /app/data ./data
COPY firebase-applet-config.json ./

EXPOSE 3000
CMD ["npm", "start"]
```

Build and run the container:
```bash
docker build -t setu-safe-internet .
docker run -p 3000:3000 \
  -e GEMINI_API_KEY="your_gemini_api_key" \
  -e COOKIE_SECRET="your_random_secret" \
  setu-safe-internet
```

---

### 4. Deploy to Linux VPS (PM2 + Nginx)

1. SSH into your Ubuntu/Debian server and install Node.js 20+:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs nginx git
   sudo npm install -g pm2
   ```
2. Clone your repository:
   ```bash
   git clone https://github.com/your-username/setu-safe-internet.git /var/www/setu
   cd /var/www/setu
   npm install
   npm run build
   ```
3. Create your `.env` file in `/var/www/setu/.env`.
4. Start with PM2:
   ```bash
   pm2 start dist/server.cjs --name "setu-safe-internet"
   pm2 save
   pm2 startup
   ```
5. Configure Nginx reverse proxy in `/etc/nginx/sites-available/setu`:
   ```nginx
   server {
       server_name your-domain.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
6. Enable the site and configure SSL with Let's Encrypt:
   ```bash
   sudo ln -s /etc/nginx/sites-available/setu /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d your-domain.com
   ```

---

## 📡 API & Route Reference

### Child Search Routes
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Renders the primary garden browser search interface |
| `GET` | `/explore`, `/search` | Direct URL explore bar route with query (`q`) and age (`age`) |
| `POST` | `/search` | Main search endpoint; processes query via Gemini and logs to active caretaker account |

### Authentication & Account Routes
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/login` | Caretaker login page (Email/Password & Google OAuth) |
| `POST` | `/login` | Authenticates caretaker with email and cryptographic password verification |
| `GET` | `/register` | Caretaker registration page |
| `POST` | `/register` | Creates a new caretaker profile and initial PIN |
| `GET` | `/logout`, `POST` `/logout` | Safely terminates session and clears cookies |
| `POST` | `/api/auth/firebase-login` | Synchronizes Firebase client-side Google popup login with backend session |

### Parent Sanctuary & Gate Routes
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/parent-login` | PIN entry screen preventing unauthorized child access |
| `POST` | `/parent-login` | Validates caretaker PIN against the active account |
| `GET` | `/parent-lock` | Instantly locks dashboard and returns to child view |
| `GET` | `/setup-pin` | Interface to configure or reset initial 4–6 digit security PIN |
| `POST` | `/parent-change-pin` | Updates or removes the caretaker's security PIN |

### Dashboard & Analytics Routes (Protected by PIN)
| Method | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/dashboard` | Caretaker dashboard displaying account-isolated metrics and activity logs |
| `POST` | `/parent-clear-logs` | Clears search history exclusively for the authenticated account |
| `GET` | `/parent-export` | Exports search logs as CSV (`?format=csv`) or JSON (`?format=json`) |
| `POST` | `/account/update-password` | Updates or adds a password for Google-authenticated caretakers |
| `POST` | `/account/update-profile` | Updates caretaker display name |

---

## 🛡️ Security & Access Control

1. **Password Security**:
   - Uses Node.js native `crypto.scryptSync` with unique 16-byte random salt per user.
   - Timing-safe comparison (`crypto.timingSafeEqual`) against side-channel timing attacks.
2. **Session Cookie Isolation**:
   - Cookies are signed with `COOKIE_SECRET`, set to `HttpOnly`, `SameSite=None`, and `Secure` to support secure iframe integration in web sandboxes.
3. **Attribute-Based Access Control (ABAC)**:
   - Configured in `firestore.rules`.
   - Blanket queries are rejected; query logs and private settings require document-level identity verification (`resource.data.userId == request.auth.uid`).
4. **Child-Proof Protection**:
   - Caretaker PIN verification expires after 4 hours or instantly upon performing a search or clicking the lock icon.

---

## 🧪 Testing & Quality Assurance

To run the TypeScript type checker and verify that the codebase compiles without errors:

```bash
# Type check and validate code
npm run lint

# Compile and package production distribution
npm run build
```

---

## 🤝 Contributing

Contributions, bug reports, and suggestions are welcome!
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/SafeDiscovery`)
3. Commit your Changes (`git commit -m 'Add SafeDiscovery feature'`)
4. Push to the Branch (`git push origin feature/SafeDiscovery`)
5. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

<p align="center">
  Crafted with care for children's safe curiosity and parents' peace of mind 🌿
</p>
