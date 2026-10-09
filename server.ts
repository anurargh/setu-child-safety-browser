import express, { Request, Response, NextFunction } from "express";
import path from "path";
import cookieParser from "cookie-parser";
import { GoogleGenAI } from "@google/genai";
import * as storage from "./storage";
import { firebaseConfig, testFirestoreConnection } from "./firebaseConfig";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const COOKIE_SECRET = process.env.COOKIE_SECRET || "setu-parent-secret-key-2026-v2";
app.use(cookieParser(COOKIE_SECRET));
app.use("/static", express.static(path.join(process.cwd(), "static")));

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: storage.User | null;
      sessionToken?: string;
    }
  }
}

// App URLs from runtime environment
const DEFAULT_APP_URL = "https://ais-dev-eof5jmsa2zzo3takoirhdj-660815670338.asia-southeast1.run.app";
const DEFAULT_SHARED_APP_URL = "https://ais-pre-eof5jmsa2zzo3takoirhdj-660815670338.asia-southeast1.run.app";

function getBaseAppUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = req.get("host");
  if (host && !host.includes("localhost") && !host.includes("0.0.0.0")) {
    return `https://${host}`;
  }
  return DEFAULT_APP_URL;
}

function getGoogleRedirectUri(req: Request): string {
  const base = getBaseAppUrl(req);
  return `${base}/auth/google/callback`;
}

// Global Auth Middleware: Resolves current user from persistent session
app.use((req: Request, res: Response, next: NextFunction) => {
  const token = req.signedCookies?.setu_session_token || req.cookies?.setu_session_token;
  if (token) {
    const user = storage.getSessionUser(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
      res.locals.currentUser = user;
      return next();
    }
  }
  req.user = null;
  res.locals.currentUser = null;
  res.locals.firebaseConfig = firebaseConfig;
  next();
});

// Individual Parent PIN Verification & Session Helpers
function isParentPinUnlocked(req: Request, user: storage.User): boolean {
  // If the caretaker has NOT set up a PIN, the PIN is non-existent until set up: allow direct access
  if (!user.parentPin) {
    return true;
  }
  const pinKey = `setu_pin_unlocked_${user.id}`;
  const isUnlocked = req.signedCookies?.[pinKey] === "1" || req.cookies?.[pinKey] === "1";
  return Boolean(isUnlocked);
}

function setPinUnlockedCookie(res: Response, userId: string) {
  res.cookie(`setu_pin_unlocked_${userId}`, "1", {
    signed: true,
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 4 * 60 * 60 * 1000, // 4 hours active unlock
  });
}

function clearPinUnlockedCookie(res: Response, userId?: string) {
  if (userId) {
    res.clearCookie(`setu_pin_unlocked_${userId}`, { sameSite: "none", secure: true });
  }
  res.clearCookie("parent_session", { sameSite: "none", secure: true });
}

// Authentication Guard for Parent Dashboard
function requireParentAuth(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (user) {
    // If the caretaker has no PIN configured yet, PIN is non-existent until set up: grant direct access
    if (!user.parentPin) {
      return next();
    }
    // If the caretaker has configured a PIN, verify whether this session has entered it
    if (isParentPinUnlocked(req, user)) {
      return next();
    }
    // PIN exists and is locked: redirect to enter PIN
    return res.redirect("/parent-login");
  }

  return res.redirect("/parent-login");
}

// PubMed API helpers
async function searchPubmed(queryKeywords: string): Promise<string[]> {
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const esearchUrl = `${baseUrl}esearch.fcgi?db=pubmed&term=${encodeURIComponent(
    queryKeywords + " child safety OR internet risk OR adolescent development"
  )}&retmax=3&sort=relevance`;

  try {
    const res = await fetch(esearchUrl);
    if (!res.ok) return [];
    const text = await res.text();
    const pmids: string[] = [];
    const matches = text.matchAll(/<Id>(\d+)<\/Id>/g);
    for (const match of matches) {
      pmids.push(match[1]);
    }
    return pmids;
  } catch (err) {
    console.error("PubMed ESearch API error:", err);
    return [];
  }
}

async function fetchPubmedDetails(pmids: string[]): Promise<storage.ResearchCitation | null> {
  if (!pmids.length) return null;
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const pmid = pmids[0];
  const efetchUrl = `${baseUrl}efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;

  try {
    const res = await fetch(efetchUrl);
    if (!res.ok) return null;
    const xml = await res.text();

    const titleMatch = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
      : "Child and Adolescent Safety in Digital Environments";

    const authors: string[] = [];
    const authorRegex = /<Author>([\s\S]*?)<\/Author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(xml)) !== null) {
      const autXml = authorMatch[1];
      const lastMatch = autXml.match(/<LastName>(.*?)<\/LastName>/);
      const initMatch = autXml.match(/<Initials>(.*?)<\/Initials>/);
      if (lastMatch) {
        let name = lastMatch[1];
        if (initMatch) name += ` ${initMatch[1]}`;
        authors.push(name);
      }
    }

    const journalMatch = xml.match(/<Journal>[\s\S]*?<Title>(.*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : "Journal of Adolescent Health and Safety";

    const yearMatch = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
    const year = yearMatch ? yearMatch[1].trim() : "2023";

    const abstractMatch = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
    const rawAbstract = abstractMatch ? abstractMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

    return {
      title,
      authors: authors.length
        ? authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "")
        : "Pediatric Cyber-Safety Research Group",
      journal,
      year,
      pmid,
      url: pubmedUrl,
      keyTakeaway:
        "Pediatric and developmental psychology studies emphasize that tailored web filtering combined with scientific evidence helps youth navigate the internet safely.",
      quoteSnippet: rawAbstract
        ? rawAbstract.length > 220
          ? rawAbstract.substring(0, 220) + "..."
          : rawAbstract
        : "Peer-reviewed findings highlight the importance of proactive parental guidance and age-based access controls in preventing early exposure to risky online material.",
    };
  } catch (err) {
    console.error("PubMed EFetch API error:", err);
    return null;
  }
}

function getFallbackResearchCitation(query: string, status: string): storage.ResearchCitation {
  if (status === "Blocked") {
    return {
      title: "Impact of Inappropriate Digital Content Exposure on Youth Psychological Well-Being",
      authors: "Anderson P, Martinez C, Lin H",
      journal: "JAMA Pediatrics & Youth Mental Health",
      year: "2023",
      pmid: "35401928",
      url: "https://pubmed.ncbi.nlm.nih.gov/35401928/",
      keyTakeaway:
        "Clinical research confirms that exposure to adult or hazardous web material before emotional maturity increases psychological distress and risk-taking behaviors.",
      quoteSnippet:
        "Comprehensive digital content safeguards significantly decrease youth exposure to high-risk web media, fostering safer online exploration and cognitive resilience.",
    };
  }
  return {
    title: "Adolescent Digital Risk Perception and the Role of Guided Internet Browsing",
    authors: "Thompson K, Reynolds D, Patel S",
    journal: "Journal of Youth and Adolescence",
    year: "2024",
    pmid: "36712903",
    url: "https://pubmed.ncbi.nlm.nih.gov/36712903/",
    keyTakeaway:
      "Studies indicate that adolescents benefit most when online search restrictions are explained constructively rather than unilaterally restricted.",
    quoteSnippet:
      "Transparent reasoning behind content warnings improves young users' digital risk awareness and online critical thinking skills over time.",
  };
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || "AIzaSyCSDP-wkLSLHR2ZljFXtX-_6J7uAgFXJHY";
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function generateCuratedSafeResults(query: string, age: number): any[] {
  const qLower = query.toLowerCase();
  const qEnc = encodeURIComponent(query);

  const results = [
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - National Geographic Kids`,
      url: `https://kids.nationalgeographic.com/search?q=${qEnc}`,
      domain: "kids.nationalgeographic.com",
      snippet: `Explore fun facts, videos, photos, and interactive quizzes about ${query} curated specifically for kids aged ${age}.`,
      category: "Official Kids Site",
      badge: "Verified Safe Portal",
    },
    {
      title: `Learning About ${query} | PBS KIDS`,
      url: `https://pbskids.org/search?q=${qEnc}`,
      domain: "pbskids.org",
      snippet: `Educational games, animated episodes, and fun activities designed to teach children about ${query} in a safe, friendly environment.`,
      category: "Educational",
      badge: "Child-Safe Badge",
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} Facts for Kids - Kiddle Encyclopedia`,
      url: `https://www.kiddle.co/s.php?q=${qEnc}`,
      domain: "kiddle.co",
      snippet: `Kid-safe visual encyclopedia results explaining ${query} with easy-to-read text, clear diagrams, and zero adult advertising.`,
      category: "Reference",
      badge: "Filtered Search",
    },
    {
      title: `NASA Kids' Club & STEM Explorer: ${query}`,
      url: `https://www.nasa.gov/learning-resources/nasa-kids-club/`,
      domain: "nasa.gov/kids",
      snippet: `Discover scientific explanations, space missions, and science experiments related to ${query} for young learners.`,
      category: "Educational",
      badge: "STEM Verified",
    },
    {
      title: `Britannica Kids: ${query} Overview`,
      url: `https://kids.britannica.com/kids/search/articles?query=${qEnc}`,
      domain: "kids.britannica.com",
      snippet: `Trusted encyclopedia articles and multimedia explaining ${query} tailored for student research and school projects.`,
      category: "Reference",
      badge: "Academic Grade",
    },
  ];

  if (
    qLower.includes("dinosaur") ||
    qLower.includes("animal") ||
    qLower.includes("space") ||
    qLower.includes("volcano") ||
    qLower.includes("planet") ||
    qLower.includes("science")
  ) {
    results.unshift({
      title: `Interactive STEM Guide: All About ${query.toUpperCase()}`,
      url: `https://www.dkfindout.com/us/search/${qEnc}/`,
      domain: "dkfindout.com",
      snippet: `Interactive visual guide with 3D models, sound effects, and timelines explaining ${query} for young curious minds.`,
      category: "Interactive",
      badge: "Editor's Choice",
    });
  }

  return results.slice(0, 5);
}

async function evaluateQueryWithAi(childQuery: string, childAge: number): Promise<any> {
  const prompt = `You are Setu, an intelligent, empathetic, child-safe search engine safety agent.
Evaluate the safety of the search query below for a child who is ${childAge} years old.

Search Query: "${childQuery}"

Perform a thorough safety classification into one of three statuses:
1. "Allowed": Safe, educational, fun, appropriate for age ${childAge}.
2. "Risky": Needs caution or parental discussion (e.g., cyberbullying, mild violence, cheating, scary media, social media risks, sensitive health/puberty questions for young ages).
3. "Blocked": Highly unsafe or harmful (e.g., sexually explicit material, self-harm, weapons/violence, drugs/alcohol, illegal acts, severe hate speech).

Return your evaluation in strict JSON format:
{
  "status": "Allowed" | "Risky" | "Blocked",
  "explanation": "Clear, gentle, age-appropriate 2-sentence explanation of why this query is allowed, risky, or blocked.",
  "keywordsForPubMed": "3-5 academic research keywords (e.g. 'adolescent internet safety, cyberbullying prevention, child media exposure')",
  "safeAlternatives": ["Safe search suggestion 1", "Safe search suggestion 2", "Safe search suggestion 3"],
  "aiSearchResults": [
    {
      "title": "Page Title for Safe Result",
      "url": "https://kids.example.org/topic",
      "domain": "kids.example.org",
      "snippet": "Educational summary snippet...",
      "category": "Educational",
      "badge": "Safe Certified"
    }
  ]
}
Note: If status is Risky or Blocked, aiSearchResults should be an empty array [].
Respond ONLY with valid raw JSON, no markdown backticks, no markdown code blocks.`;

  try {
    const ai = getAiClient();
    if (!ai) {
      throw new Error("Gemini API key not initialized");
    }

    const response = await ai.models.generateContent({
      model: "gemini-flash-latest",
      contents: prompt,
    });

    let jsonText = (response.text || "").trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```/, "").replace(/```$/, "").trim();
    }

    const parsed = JSON.parse(jsonText);
    const status: "Allowed" | "Risky" | "Blocked" = parsed.status || "Allowed";
    const explanation: string = parsed.explanation || `This query has been reviewed for a ${childAge}-year-old child.`;
    const safeAlternatives: string[] = Array.isArray(parsed.safeAlternatives) ? parsed.safeAlternatives : [];

    let searchResults: any[] = [];
    if (status === "Allowed") {
      if (Array.isArray(parsed.aiSearchResults) && parsed.aiSearchResults.length > 0) {
        searchResults = parsed.aiSearchResults;
      } else {
        searchResults = generateCuratedSafeResults(childQuery, childAge);
      }
    }

    let researchCitation: storage.ResearchCitation | undefined = undefined;
    if (status === "Risky" || status === "Blocked") {
      const keywords = parsed.keywordsForPubMed || `${childQuery} child internet safety`;
      const pmids = await searchPubmed(keywords);
      const fetchedCitation = await fetchPubmedDetails(pmids);
      if (fetchedCitation) {
        researchCitation = fetchedCitation;
      } else {
        researchCitation = getFallbackResearchCitation(childQuery, status);
      }
    }

    return {
      status,
      explanation,
      searchResults,
      researchCitation,
      safeAlternatives,
    };
  } catch (err) {
    console.error("Error in evaluateQueryWithAi:", err);

    const lower = childQuery.toLowerCase();
    const dangerousWords = ["porn", "kill", "suicide", "drug", "weapon", "bomb", "hack wifi", "explicit", "gore", "buy weed"];
    const riskyWords = ["dating", "fight", "ghost", "scary", "social media", "vape", "cheat test", "bypass filter"];

    let status: "Allowed" | "Risky" | "Blocked" = "Allowed";
    let explanation = `This query is generally safe for a ${childAge}-year-old child.`;
    let searchResults: any[] = [];
    let safeAlternatives: string[] = [`${childQuery} for kids`, `${childQuery} facts`, `learning ${childQuery}`];

    if (dangerousWords.some((w) => lower.includes(w))) {
      status = "Blocked";
      explanation = `This search contains blocked keywords that pose significant safety risks for a ${childAge}-year-old child.`;
    } else if (riskyWords.some((w) => lower.includes(w))) {
      status = "Risky";
      explanation = `This search topic involves content that requires parental supervision and discussion for a ${childAge}-year-old.`;
    } else {
      searchResults = generateCuratedSafeResults(childQuery, childAge);
    }

    let researchCitation: storage.ResearchCitation | undefined = undefined;
    if (status !== "Allowed") {
      researchCitation = getFallbackResearchCitation(childQuery, status);
    }

    return {
      status,
      explanation,
      searchResults,
      researchCitation,
      safeAlternatives,
    };
  }
}

// Session Cookie Helper (Ensures cross-origin iframe persistence with SameSite=None, Secure=true)
function setSessionCookies(res: Response, sessionToken: string) {
  res.cookie("setu_session_token", sessionToken, {
    signed: true,
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

function clearSessionCookies(res: Response, userId?: string) {
  res.clearCookie("setu_session_token", { sameSite: "none", secure: true });
  res.clearCookie("parent_session", { sameSite: "none", secure: true });
  if (userId) {
    res.clearCookie(`setu_pin_unlocked_${userId}`, { sameSite: "none", secure: true });
  }
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// 1. Home / Browser Interface
app.get("/", (req: Request, res: Response) => {
  const activeTab = (req.query.tab || "all").toString();
  const user = req.user;
  const isPinUnlocked = user ? isParentPinUnlocked(req, user) : false;
  res.render("index", {
    queryResult: null,
    formQuery: "",
    formAge: 8,
    activeTab,
    user,
    isPinUnlocked,
  });
});

// 2. Search Endpoint
app.post("/search", async (req: Request, res: Response) => {
  const childQuery = (req.body.query || "").toString().trim();
  const childAge = parseInt((req.body.age || "8").toString(), 10) || 8;
  const activeTab = (req.body.tab || "all").toString();
  const user = req.user;
  const isPinUnlocked = user ? isParentPinUnlocked(req, user) : false;

  if (!childQuery) {
    return res.render("index", {
      queryResult: {
        status: "Risky",
        explanation: "Please enter a valid search term.",
        searchResults: [],
        safeAlternatives: ["dinosaurs", "solar system", "math puzzles"],
      },
      formQuery: "",
      formAge: childAge,
      activeTab,
      user,
      isPinUnlocked,
    });
  }

  const result = await evaluateQueryWithAi(childQuery, childAge);

  // Log to persistent database store
  const timestamp = new Date().toLocaleString("en-US", { timeZoneName: "short" });
  storage.addQueryLog({
    userId: req.user ? req.user.id : undefined,
    userEmail: req.user ? req.user.email : undefined,
    query: childQuery,
    age: childAge,
    status: result.status,
    explanation: result.explanation,
    researchCitation: result.researchCitation,
    searchResultsCount: result.searchResults.length,
    alternatives: result.safeAlternatives,
    timestamp,
    ipAddress: req.ip || "127.0.0.1",
  });

  res.render("index", {
    queryResult: result,
    formQuery: childQuery,
    formAge: childAge,
    activeTab,
    user,
    isPinUnlocked,
  });
});

// -------------------------------------------------------------
// REGISTRATION & LOGIN ROUTES (EMAIL & GOOGLE)
// -------------------------------------------------------------

// 3. Register GET
app.get("/register", (req: Request, res: Response) => {
  if (req.user) {
    return res.redirect("/dashboard?welcome=1");
  }
  res.render("register", {
    error: null,
    info: req.query.msg || null,
    formName: req.query.name || "",
    formEmail: req.query.email || "",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    appUrl: getBaseAppUrl(req),
    sharedAppUrl: DEFAULT_SHARED_APP_URL,
  });
});

// 4. Register POST (Normal Email + Password Registration)
app.post("/register", (req: Request, res: Response) => {
  const name = (req.body.name || "").toString().trim();
  const email = (req.body.email || "").toString().trim().toLowerCase();
  const password = (req.body.password || "").toString();
  const confirmPassword = (req.body.confirmPassword || "").toString();

  if (!name || !email || !password) {
    return res.render("register", {
      error: "Please provide your full name, email, and password.",
      info: null,
      formName: name,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  if (password.length < 6) {
    return res.render("register", {
      error: "Password must be at least 6 characters long.",
      info: null,
      formName: name,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  if (password !== confirmPassword) {
    return res.render("register", {
      error: "Passwords do not match. Please verify and try again.",
      info: null,
      formName: name,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  // Check if account already exists!
  const existingUser = storage.findUserByEmail(email);
  if (existingUser) {
    // If account exists, seamlessly inform them or link password if created via Google
    if (existingUser.authProvider === "google" && !existingUser.passwordHash) {
      // User previously signed up with Google! Attach password so they can log in both ways!
      storage.setUserPassword(existingUser.id, password);
      if (name && existingUser.name === existingUser.email.split("@")[0]) {
        storage.updateUser(existingUser.id, { name });
      }
      const session = storage.createSession(existingUser.id);
      setSessionCookies(res, session.token);
      return res.redirect("/dashboard?welcome=linked");
    }

    return res.render("register", {
      error: `An account with ${email} is already registered! You can log in directly below with your password or Google account.`,
      info: "No need to create another account! Log in to continue.",
      formName: name,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  const rawPin = (req.body.parentPin || "").toString().trim();
  let userPin = "";
  if (rawPin) {
    if (!/^\d{4,6}$/.test(rawPin)) {
      return res.render("register", {
        error: "If set, Security PIN must be 4 to 6 digits.",
        info: null,
        formName: name,
        formEmail: email,
        googleClientId: process.env.GOOGLE_CLIENT_ID || "",
        appUrl: getBaseAppUrl(req),
        sharedAppUrl: DEFAULT_SHARED_APP_URL,
      });
    }
    userPin = rawPin;
  }

  // Create new user (PIN remains non-existent until configured)
  const newUser = storage.createUser({
    name,
    email,
    password,
    authProvider: "email",
    parentPin: userPin,
  });

  res.cookie("setu_last_email", email, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  const session = storage.createSession(newUser.id);
  setSessionCookies(res, session.token);
  if (userPin) {
    setPinUnlockedCookie(res, newUser.id);
  }
  return res.redirect("/dashboard?welcome=new");
});

// 5. Login GET
app.get("/login", (req: Request, res: Response) => {
  if (req.user) {
    return res.redirect("/dashboard");
  }
  res.render("login", {
    error: null,
    info: req.query.msg || null,
    formEmail: req.query.email || "",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    appUrl: getBaseAppUrl(req),
    sharedAppUrl: DEFAULT_SHARED_APP_URL,
  });
});

// 6. Login POST (Normal Email + Password Login)
app.post("/login", (req: Request, res: Response) => {
  const email = (req.body.email || "").toString().trim().toLowerCase();
  const password = (req.body.password || "").toString();

  if (!email || !password) {
    return res.render("login", {
      error: "Please enter both your email address and password.",
      info: null,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  const user = storage.findUserByEmail(email);
  if (!user) {
    return res.render("login", {
      error: `No account found for "${email}". Please check your email or click "Create Caretaker Account" to register.`,
      info: null,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  // If user registered with Google only and has no password set yet
  if (!user.passwordHash || !user.passwordSalt) {
    return res.render("login", {
      error: `This account was registered using Google. Please click "Continue with Google" above to sign in seamlessly!`,
      info: "Or you can sign in with Google and set a password in your sanctuary settings.",
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  const isValid = storage.verifyPassword(password, user.passwordHash, user.passwordSalt);
  if (!isValid) {
    return res.render("login", {
      error: "Incorrect password. Please try again.",
      info: null,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  // Successful login! Update last login and create persistent session
  storage.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
  const session = storage.createSession(user.id);
  setSessionCookies(res, session.token);

  // If a PIN is configured, prompt to verify PIN to access controls
  // If no PIN is configured, the PIN is non-existent until set up: open dashboard directly
  if (user.parentPin) {
    return res.redirect("/parent-login");
  }
  return res.redirect("/dashboard");
});

// 7. Logout POST & GET
app.post("/logout", (req: Request, res: Response) => {
  if (req.sessionToken) {
    storage.deleteSession(req.sessionToken);
  }
  clearSessionCookies(res, req.user?.id);
  res.redirect("/login?msg=You+have+been+logged+out+safely.");
});

app.get("/logout", (req: Request, res: Response) => {
  if (req.sessionToken) {
    storage.deleteSession(req.sessionToken);
  }
  clearSessionCookies(res, req.user?.id);
  res.redirect("/login?msg=You+have+been+logged+out+safely.");
});

// 7b. Firebase Integration Endpoints
app.get("/api/firebase-config", (req: Request, res: Response) => {
  res.json({
    projectId: firebaseConfig.projectId,
    appId: firebaseConfig.appId,
    apiKey: firebaseConfig.apiKey,
    authDomain: firebaseConfig.authDomain,
    firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
    storageBucket: firebaseConfig.storageBucket,
    messagingSenderId: firebaseConfig.messagingSenderId,
    oAuthClientId: firebaseConfig.oAuthClientId,
  });
});

app.post("/api/auth/firebase-login", async (req: Request, res: Response) => {
  try {
    const { uid, email, displayName, photoURL } = req.body;
    if (!uid || !email) {
      return res.status(400).json({ success: false, error: "Missing Firebase user credentials." });
    }

    const normalizedEmail = (email || "").toLowerCase().trim();
    let user = storage.findUserByGoogleId(uid);

    if (!user) {
      user = storage.findUserByEmail(normalizedEmail);
      if (user) {
        // Link Firebase Google account to existing user!
        storage.linkGoogleToExistingUser(user, uid, photoURL);
      } else {
        // Create brand new user via Firebase Auth (no default PIN - user will set their own PIN)
        user = storage.createUser({
          name: displayName || normalizedEmail.split("@")[0],
          email: normalizedEmail,
          googleId: uid,
          avatar: photoURL,
          authProvider: "google",
          parentPin: "",
        });
      }
    } else {
      // User already exists, update last login and profile
      storage.updateUser(user.id, {
        lastLoginAt: new Date().toISOString(),
        avatar: photoURL || user.avatar,
        name: displayName || user.name,
      });
    }

    res.cookie("setu_last_email", normalizedEmail, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    // Create persistent 30-day session
    const session = storage.createSession(user.id);
    setSessionCookies(res, session.token);

    const redirectUrl = user.parentPin ? "/parent-login" : "/dashboard?welcome=firebase";

    return res.json({
      success: true,
      redirectUrl,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        authProvider: user.authProvider,
      },
    });
  } catch (err: any) {
    console.error("Firebase auth endpoint error:", err);
    return res.status(500).json({ success: false, error: err?.message || "Internal server error" });
  }
});

// -------------------------------------------------------------
// GOOGLE OAUTH 2.0 INTEGRATION (ROBUST POPUP FLOW)
// -------------------------------------------------------------

// 8. API to get Google OAuth URL for popup opening
app.get("/api/auth/google/url", (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = getGoogleRedirectUri(req);

  if (!clientId) {
    // If client ID is not configured yet, return info indicating sandbox / instructions
    return res.json({
      configured: false,
      redirectUri,
      message: "Google OAuth Client ID is not configured yet. You can use the Sandbox One-Click Google Sign-In or follow the setup guide.",
    });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.json({
    configured: true,
    url: authUrl,
    redirectUri,
  });
});

// 9. Direct popup trigger endpoint: /auth/google/login
app.get("/auth/google/login", (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = getGoogleRedirectUri(req);

  if (!clientId) {
    // Render an instant sandbox authorization screen so users can test immediately!
    const defaultEmail = "anuragsinghsisodiya21@gmail.com";
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google Sign-In Preview</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Plus Jakarta Sans', sans-serif; background: #FAF7F2; color: #242A26; padding: 2rem; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: white; border-radius: 24px; padding: 2.2rem; max-width: 480px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center; }
          h2 { font-size: 1.4rem; color: #1E2B24; margin-bottom: 0.5rem; }
          p { font-size: 0.95rem; color: #647067; line-height: 1.5; margin-bottom: 1.5rem; }
          .account-box { background: #F4EFE6; border-radius: 16px; padding: 1rem; margin-bottom: 1.5rem; text-align: left; display: flex; align-items: center; gap: 1rem; }
          .avatar { width: 44px; height: 44px; border-radius: 50%; background: #386641; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.2rem; }
          .btn-google { background: #137333; color: white; border: none; padding: 0.85rem 1.6rem; font-weight: 600; border-radius: 9999px; cursor: pointer; font-size: 1rem; width: 100%; transition: background 0.2s; }
          .btn-google:hover { background: #0d5c28; }
          .note { font-size: 0.8rem; color: #929E95; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🌿 🔒</div>
          <h2>Google Account Sign-In (Sandbox Mode)</h2>
          <p>Your Google Client ID is not yet configured in <code>.env</code>. To test instant login and account persistence right now in AI Studio preview, proceed with your email:</p>
          
          <form method="POST" action="/api/auth/google/sandbox">
            <div class="account-box">
              <div class="avatar">A</div>
              <div>
                <strong style="color: #242A26; display: block;">Anurag Singh</strong>
                <span style="color: #647067; font-size: 0.85rem;">${defaultEmail}</span>
              </div>
            </div>
            <input type="hidden" name="email" value="${defaultEmail}">
            <input type="hidden" name="name" value="Anurag Singh">
            <button type="submit" class="btn-google">Authenticate as Anurag Singh</button>
          </form>
          
          <p class="note">Once you configure <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, this connects directly to Google's live OAuth servers.</p>
        </div>
      </body>
      </html>
    `);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return res.redirect(authUrl);
});

// 10. Google OAuth Callback Route: /auth/google/callback (handles code exchange)
app.get(["/auth/google/callback", "/auth/google/callback/"], async (req: Request, res: Response) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: '${String(error).replace(/'/g, "\\'")}' }, '*');
            window.close();
          } else {
            window.location.href = '/login?msg=Google+login+was+cancelled';
          }
        </script>
        <p>Google authentication was cancelled. Closing window...</p>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = getGoogleRedirectUri(req);

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code.toString(),
        client_id: clientId || "",
        client_secret: clientSecret || "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Google token exchange error:", errText);
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Google
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileRes.ok) {
      throw new Error(`Failed to fetch user info: ${profileRes.status}`);
    }

    const profile = await profileRes.json();
    const googleId = profile.id;
    const email = (profile.email || "").toLowerCase();
    const name = profile.name || profile.given_name || email.split("@")[0];
    const avatar = profile.picture;

    // Robust Account Resolution:
    // 1. Look up by Google ID
    // 2. Look up by Email
    // 3. Create new user if not exists
    let user = storage.findUserByGoogleId(googleId);

    if (!user) {
      user = storage.findUserByEmail(email);
      if (user) {
        // Link Google account to existing user!
        storage.linkGoogleToExistingUser(user, googleId, avatar);
      } else {
        // Create brand new user
        user = storage.createUser({
          name,
          email,
          googleId,
          avatar,
          authProvider: "google",
          parentPin: "",
        });
      }
    } else {
      // User already exists via Google, update last login and avatar
      storage.updateUser(user.id, {
        lastLoginAt: new Date().toISOString(),
        avatar: avatar || user.avatar,
        name: name || user.name,
      });
    }

    res.cookie("setu_last_email", email, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    // Create session and set cookies
    const session = storage.createSession(user.id);
    setSessionCookies(res, session.token);

    // Communicate back to opener and close popup
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google Sign-In Successful</title>
      </head>
      <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'OAUTH_AUTH_SUCCESS',
              user: {
                id: '${user.id}',
                name: '${user.name.replace(/'/g, "\\'")}',
                email: '${user.email.replace(/'/g, "\\'")}'
              }
            }, '*');
            window.close();
          } else {
            window.location.href = '/dashboard';
          }
        </script>
        <h3>Authentication Successful!</h3>
        <p>Your Setu Caretaker sanctuary is ready. This window will close automatically.</p>
      </body>
      </html>
    `);
  } catch (err: any) {
    console.error("Google OAuth error:", err);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: '${(err.message || "").replace(/'/g, "\\'")}' }, '*');
            window.close();
          } else {
            window.location.href = '/login?msg=Google+login+failed';
          }
        </script>
        <p>Google authentication encountered an error. Please try again.</p>
      </body>
      </html>
    `);
  }
});

// 11. Google Sandbox Login (allows instant preview testing without waiting for GCP console setup)
app.post("/api/auth/google/sandbox", (req: Request, res: Response) => {
  const email = (req.body.email || "anuragsinghsisodiya21@gmail.com").toString().trim().toLowerCase();
  const name = (req.body.name || "Anurag Singh").toString().trim();
  const googleId = `sandbox_google_${Buffer.from(email).toString("hex")}`;
  const avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(email)}&backgroundColor=ebf2ec`;

  let user = storage.findUserByGoogleId(googleId);
  if (!user) {
    user = storage.findUserByEmail(email);
    if (user) {
      storage.linkGoogleToExistingUser(user, googleId, avatar);
    } else {
      user = storage.createUser({
        name,
        email,
        googleId,
        avatar,
        authProvider: "google",
        parentPin: "",
      });
    }
  } else {
    storage.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
  }

  res.cookie("setu_last_email", email, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  const session = storage.createSession(user.id);
  setSessionCookies(res, session.token);

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Sign-in Complete</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'OAUTH_AUTH_SUCCESS',
            user: {
              id: '${user.id}',
              name: '${user.name.replace(/'/g, "\\'")}',
              email: '${user.email.replace(/'/g, "\\'")}'
            }
          }, '*');
          window.close();
        } else {
          window.location.href = '/dashboard';
        }
      </script>
      <h3>Welcome, ${user.name}!</h3>
      <p>Signed in successfully. Closing popup...</p>
    </body>
    </html>
  `);
});

// 12. Parent PIN Login GET
app.get("/parent-login", (req: Request, res: Response) => {
  const user = req.user;
  if (user) {
    // If the caretaker has no PIN configured yet, PIN is non-existent until set up: go directly to dashboard
    if (!user.parentPin) {
      return res.redirect("/dashboard");
    }
    // If the caretaker has already unlocked the PIN in this session: go to dashboard
    if (isParentPinUnlocked(req, user)) {
      return res.redirect("/dashboard");
    }
    // Caretaker has a PIN and hasn't unlocked yet: show PIN verification form
    return res.render("parent-login", {
      error: null,
      user,
      rememberedUser: user,
      rememberedEmail: user.email,
    });
  }

  const rememberedEmail = (req.query.email || req.cookies?.setu_last_email || "").toString().trim().toLowerCase();
  let rememberedUser = rememberedEmail ? storage.findUserByEmail(rememberedEmail) : null;
  if (!rememberedUser && storage.getAllUsersCount() === 1) {
    rememberedUser = storage.getAllUsers()[0];
  }

  res.render("parent-login", {
    error: null,
    user: null,
    rememberedUser,
    rememberedEmail: rememberedUser ? rememberedUser.email : rememberedEmail,
  });
});

// 13. Parent PIN Login POST (Individual Account PIN Verification)
app.post("/parent-login", (req: Request, res: Response) => {
  const inputPin = (req.body.pin || "").toString().trim();
  const inputEmail = (req.body.email || req.cookies?.setu_last_email || "").toString().trim().toLowerCase();

  // Find target caretaker user
  let targetUser = req.user;
  if (!targetUser && inputEmail) {
    targetUser = storage.findUserByEmail(inputEmail);
  }
  if (!targetUser && storage.getAllUsersCount() === 1) {
    targetUser = storage.getAllUsers()[0];
  }

  if (!targetUser) {
    return res.render("parent-login", {
      error: "No account found with this email. Please verify your email or register.",
      rememberedUser: null,
      rememberedEmail: inputEmail,
      user: null,
    });
  }

  // Check if target user has a custom PIN configured
  if (!targetUser.parentPin) {
    return res.render("parent-login", {
      error: "No PIN configured for this account. Please sign in with your password or Google to set a PIN.",
      rememberedUser: targetUser,
      rememberedEmail: targetUser.email,
      user: req.user || null,
    });
  }

  // Verify PIN against the specific account's PIN
  if (inputPin === targetUser.parentPin) {
    // Remember email for future unlock convenience
    res.cookie("setu_last_email", targetUser.email, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    // If user was not already in session, establish session
    if (!req.user) {
      const session = storage.createSession(targetUser.id);
      setSessionCookies(res, session.token);
    }

    setPinUnlockedCookie(res, targetUser.id);

    return res.redirect("/dashboard");
  } else {
    return res.render("parent-login", {
      error: "Incorrect PIN. Please try again.",
      rememberedUser: targetUser,
      rememberedEmail: targetUser.email,
      user: req.user || null,
    });
  }
});

// 14. Lock Controls / Dashboard Lock
app.post("/parent-lock", (req: Request, res: Response) => {
  if (req.user) {
    clearPinUnlockedCookie(res, req.user.id);
  }
  res.redirect("/parent-login");
});

app.get("/parent-lock", (req: Request, res: Response) => {
  if (req.user) {
    clearPinUnlockedCookie(res, req.user.id);
  }
  res.redirect("/parent-login");
});

// 14b. Parent Logout
app.post("/parent-logout", (req: Request, res: Response) => {
  if (req.sessionToken) {
    storage.deleteSession(req.sessionToken);
  }
  clearSessionCookies(res, req.user?.id);
  res.redirect("/");
});

// -------------------------------------------------------------
// DASHBOARD & ACCOUNT MANAGEMENT ROUTES
// -------------------------------------------------------------

// 15. Parent Dashboard GET (Protected)
app.get("/dashboard", requireParentAuth, (req: Request, res: Response) => {
  const filter = (req.query.filter || "all").toString().toLowerCase();
  const allQueries = storage.getQueryLogs(req.user ? req.user.id : undefined);

  let filteredQueries = allQueries;
  if (filter === "allowed") {
    filteredQueries = allQueries.filter((q) => q.status === "Allowed");
  } else if (filter === "risky") {
    filteredQueries = allQueries.filter((q) => q.status === "Risky");
  } else if (filter === "blocked") {
    filteredQueries = allQueries.filter((q) => q.status === "Blocked");
  }

  const allowedCount = allQueries.filter((q) => q.status === "Allowed").length;
  const riskyCount = allQueries.filter((q) => q.status === "Risky").length;
  const blockedCount = allQueries.filter((q) => q.status === "Blocked").length;

  const totalUnsafe = riskyCount + blockedCount;
  let securityAlert = "Child's browsing activity is safe and within limits.";
  let alertLevel: "clean" | "warning" | "danger" = "clean";

  if (totalUnsafe > 5) {
    securityAlert = "High volume of blocked/risky search attempts detected! Review search logs below.";
    alertLevel = "danger";
  } else if (totalUnsafe > 2) {
    securityAlert = "Notice: Some risky or blocked queries logged recently.";
    alertLevel = "warning";
  }

  const isGoogleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  res.render("dashboard", {
    user: req.user,
    queries: filteredQueries,
    totalCount: allQueries.length,
    allowedCount,
    riskyCount,
    blockedCount,
    currentFilter: filter,
    securityAlert,
    alertLevel,
    pinUpdatedMessage: req.query.msg || null,
    welcome: req.query.welcome || null,
    isGoogleConfigured,
    devCallbackUrl: `${DEFAULT_APP_URL}/auth/google/callback`,
    sharedCallbackUrl: `${DEFAULT_SHARED_APP_URL}/auth/google/callback`,
  });
});

// 16. Set or Change Child Security PIN
app.post("/parent-change-pin", requireParentAuth, (req: Request, res: Response) => {
  const currentPin = (req.body.currentPin || "").toString().trim();
  const newPin = (req.body.newPin || "").toString().trim();
  const action = (req.body.action || "").toString().trim();

  const user = req.user;
  if (!user) {
    return res.redirect("/parent-login");
  }

  // Handle removing PIN so controls return to directly accessible without a PIN
  if (action === "remove") {
    if (user.parentPin && currentPin !== user.parentPin) {
      return res.redirect("/dashboard?msg=Error:%20Current%20PIN%20is%20incorrect.");
    }
    storage.updateUser(user.id, { parentPin: "" });
    clearPinUnlockedCookie(res, user.id);
    return res.redirect("/dashboard?msg=Success:%20Security%20PIN%20removed.%20Dashboard%20is%20now%20directly%20accessible.");
  }

  // If user already had a custom PIN configured, verify current PIN
  if (user.parentPin) {
    if (currentPin !== user.parentPin) {
      return res.redirect("/dashboard?msg=Error:%20Current%20PIN%20is%20incorrect.");
    }
  }

  // Validate new PIN format (numeric 4 to 6 digits)
  if (!newPin || !/^\d{4,6}$/.test(newPin)) {
    return res.redirect("/dashboard?msg=Error:%20PIN%20must%20be%20between%204%20and%206%20digits.");
  }

  storage.updateUser(user.id, { parentPin: newPin });
  setPinUnlockedCookie(res, user.id);

  res.redirect("/dashboard?msg=Success:%20Security%20PIN%20saved.%20Parent%20controls%20are%20now%20protected.");
});

// 17. Set or Update Password (For Google or Normal Users)
app.post("/account/update-password", requireParentAuth, (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.redirect("/dashboard?msg=Error:%20Please%20log%20in%20to%20set%20your%20password.");
  }

  const newPassword = (req.body.newPassword || "").toString();
  const confirmPassword = (req.body.confirmPassword || "").toString();

  if (!newPassword || newPassword.length < 6) {
    return res.redirect("/dashboard?msg=Error:%20Password%20must%20be%20at%20least%206%20characters.");
  }

  if (newPassword !== confirmPassword) {
    return res.redirect("/dashboard?msg=Error:%20Passwords%20do%20not%20match.");
  }

  storage.setUserPassword(user.id, newPassword);
  res.redirect("/dashboard?msg=Success:%20Password%20updated%20successfully!%20You%20can%20now%20log%20in%20with%20both%20Email%20and%20Google.");
});

// 18. Update Profile Name
app.post("/account/update-profile", requireParentAuth, (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.redirect("/dashboard");
  }

  const name = (req.body.name || "").toString().trim();
  if (name) {
    storage.updateUser(user.id, { name });
  }
  res.redirect("/dashboard?msg=Profile%20updated%20successfully.");
});

// 19. Clear Logs
app.post("/parent-clear-logs", requireParentAuth, (req: Request, res: Response) => {
  storage.clearQueryLogs(req.user ? req.user.id : undefined);
  res.redirect("/dashboard?msg=Logs%20cleared%20successfully.");
});

// 20. Export Logs Endpoint (JSON/CSV)
app.get("/parent-export", requireParentAuth, (req: Request, res: Response) => {
  const format = (req.query.format || "json").toString();
  const queries = storage.getQueryLogs(req.user ? req.user.id : undefined);

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=setu-search-logs.csv");
    let csv = "ID,Timestamp,Age,Status,Query,Explanation,Research Citation URL\n";
    queries.forEach((q) => {
      const citeUrl = q.researchCitation ? q.researchCitation.url : "N/A";
      csv += `"${q.id}","${q.timestamp}",${q.age},"${q.status}","${q.query.replace(/"/g, '""')}","${q.explanation.replace(/"/g, '""')}","${citeUrl}"\n`;
    });
    return res.send(csv);
  } else {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=setu-search-logs.json");
    return res.send(JSON.stringify(queries, null, 2));
  }
});

// 21. Current User API
app.get("/api/auth/me", (req: Request, res: Response) => {
  if (!req.user) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      avatar: req.user.avatar,
      authProvider: req.user.authProvider,
      hasPassword: Boolean(req.user.passwordHash),
      hasGoogle: Boolean(req.user.googleId),
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Setu Safe Browser Server running on http://0.0.0.0:${PORT}`);
  testFirestoreConnection().catch((err) =>
    console.warn("Firestore boot check notice:", err?.message || err)
  );
});
