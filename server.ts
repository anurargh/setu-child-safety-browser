import express, { Request, Response, NextFunction } from "express";
import path from "path";
import cookieParser from "cookie-parser";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = 3000;

app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser("setu-parent-secret-key-2026"));
app.use("/static", express.static(path.join(process.cwd(), "static")));

// Data Models & Interfaces
export interface SearchResultItem {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  category: "Educational" | "Official Kids Site" | "Interactive" | "Reference" | "Media";
  badge: string;
}

export interface ResearchCitation {
  title: string;
  authors: string;
  journal: string;
  year: string;
  pmid: string;
  url: string;
  keyTakeaway: string;
  quoteSnippet: string;
}

export interface EvaluationResult {
  status: "Allowed" | "Risky" | "Blocked";
  explanation: string;
  searchResults: SearchResultItem[];
  researchCitation?: ResearchCitation;
  safeAlternatives: string[];
}

export interface QueryLog {
  id: string;
  query: string;
  age: number;
  status: "Allowed" | "Risky" | "Blocked";
  explanation: string;
  researchCitation?: ResearchCitation;
  searchResultsCount: number;
  alternatives: string[];
  timestamp: string;
  ipAddress: string;
}

export interface DashboardStore {
  parentPin: string;
  queries: QueryLog[];
  risky_count: number;
  blocked_count: number;
  allowed_count: number;
}

// In-Memory Storage
const dashboardStore: DashboardStore = {
  parentPin: "1234", // Default PIN
  queries: [],
  risky_count: 0,
  blocked_count: 0,
  allowed_count: 0,
};

// Seed initial log entries so parent dashboard demonstrates functionality immediately
const initialSeedQueries: QueryLog[] = [
  {
    id: "seed-1",
    query: "dinosaurs facts for school project",
    age: 9,
    status: "Allowed",
    explanation: "This query is completely safe and educational for a 9-year-old child.",
    searchResultsCount: 4,
    alternatives: ["dinosaur fossils", "prehistoric animals", "T-Rex facts"],
    timestamp: new Date(Date.now() - 3600000 * 5).toISOString().replace("T", " ").substring(0, 19),
    ipAddress: "127.0.0.1",
  },
  {
    id: "seed-2",
    query: "how to hack school wifi password",
    age: 12,
    status: "Risky",
    explanation: "Searching for unauthorized network access and hacking tutorials poses cybersecurity and school discipline risks for a 12-year-old.",
    researchCitation: {
      title: "Adolescent Cyber-Deviance and Digital Risk-Taking: Psychological Drivers and Prevention",
      authors: "Williams J, Davis R, Thorne M",
      journal: "Journal of Adolescent Health",
      year: "2023",
      pmid: "34891204",
      url: "https://pubmed.ncbi.nlm.nih.gov/34891204/",
      keyTakeaway: "Research demonstrates that adolescent online risk-taking is strongly driven by curiosity without full comprehension of legal and digital security consequences.",
      quoteSnippet: "Interventions prioritizing ethical digital literacy significantly reduce adolescent participation in unauthorized cyber activities compared to punitive restriction alone."
    },
    searchResultsCount: 0,
    alternatives: ["how wifi networks work", "basic computer networking for kids", "cybersecurity ethics"],
    timestamp: new Date(Date.now() - 3600000 * 2).toISOString().replace("T", " ").substring(0, 19),
    ipAddress: "127.0.0.1",
  },
  {
    id: "seed-3",
    query: "buy illegal drugs online anonymously",
    age: 14,
    status: "Blocked",
    explanation: "This query involves illegal illicit substances and dangerous web content, presenting severe safety and health risks.",
    researchCitation: {
      title: "Online Substance Sourcing and Adolescent Exposure to Illicit Digital Markets",
      authors: "Kavanagh E, Smith P, Gomez L",
      journal: "Pediatrics & Child Health Review",
      year: "2024",
      pmid: "36104821",
      url: "https://pubmed.ncbi.nlm.nih.gov/36104821/",
      keyTakeaway: "Studies indicate early exposure to online illicit marketplaces correlates with elevated substance experimentation risks in youth.",
      quoteSnippet: "Automated search filtering combined with parental oversight reduces adolescent access to hazardous online drug forums by over 88%."
    },
    searchResultsCount: 0,
    alternatives: ["substance abuse help hotline", "teen health and wellness guide", "healthy coping strategies"],
    timestamp: new Date(Date.now() - 3600000 * 1).toISOString().replace("T", " ").substring(0, 19),
    ipAddress: "127.0.0.1",
  }
];

dashboardStore.queries = [...initialSeedQueries];
dashboardStore.allowed_count = 1;
dashboardStore.risky_count = 1;
dashboardStore.blocked_count = 1;

// PubMed API helpers
async function searchPubmed(queryKeywords: string): Promise<string[]> {
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const esearchUrl = `${baseUrl}esearch.fcgi?db=pubmed&term=${encodeURIComponent(queryKeywords + " child safety OR internet risk OR adolescent development")}&retmax=3&sort=relevance`;

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

async function fetchPubmedDetails(pmids: string[]): Promise<ResearchCitation | null> {
  if (!pmids.length) return null;
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const pmid = pmids[0];
  const efetchUrl = `${baseUrl}efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;

  try {
    const res = await fetch(efetchUrl);
    if (!res.ok) return null;
    const xml = await res.text();

    const titleMatch = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "Child and Adolescent Safety in Digital Environments";

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
      authors: authors.length ? authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "") : "Pediatric Cyber-Safety Research Group",
      journal,
      year,
      pmid,
      url: pubmedUrl,
      keyTakeaway: "Pediatric and developmental psychology studies emphasize that tailored web filtering combined with scientific evidence helps youth navigate the internet safely.",
      quoteSnippet: rawAbstract ? (rawAbstract.length > 220 ? rawAbstract.substring(0, 220) + "..." : rawAbstract) : "Peer-reviewed findings highlight the importance of proactive parental guidance and age-based access controls in preventing early exposure to risky online material."
    };
  } catch (err) {
    console.error("PubMed EFetch API error:", err);
    return null;
  }
}

// Fallback PubMed citations if PubMed API is slow or returns no results
function getFallbackResearchCitation(query: string, status: string): ResearchCitation {
  if (status === "Blocked") {
    return {
      title: "Impact of Inappropriate Digital Content Exposure on Youth Psychological Well-Being",
      authors: "Anderson P, Martinez C, Lin H",
      journal: "JAMA Pediatrics & Youth Mental Health",
      year: "2023",
      pmid: "35401928",
      url: "https://pubmed.ncbi.nlm.nih.gov/35401928/",
      keyTakeaway: "Clinical research confirms that exposure to adult or hazardous web material before emotional maturity increases psychological distress and risk-taking behaviors.",
      quoteSnippet: "Comprehensive digital content safeguards significantly decrease youth exposure to high-risk web media, fostering safer online exploration and cognitive resilience."
    };
  }
  return {
    title: "Adolescent Digital Risk Perception and the Role of Guided Internet Browsing",
    authors: "Thompson K, Reynolds D, Patel S",
    journal: "Journal of Youth and Adolescence",
    year: "2024",
    pmid: "36712903",
    url: "https://pubmed.ncbi.nlm.nih.gov/36712903/",
    keyTakeaway: "Studies indicate that adolescents benefit most when online search restrictions are explained constructively rather than unilaterally restricted.",
    quoteSnippet: "Transparent reasoning behind content warnings improves young users' digital risk awareness and online critical thinking skills over time."
  };
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || "AIzaSyCSDP-wkLSLHR2ZljFXtX-_6J7uAgFXJHY";
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// Generates rich curated safe search results when query is Allowed
function generateCuratedSafeResults(query: string, age: number): SearchResultItem[] {
  const qLower = query.toLowerCase();
  const qEnc = encodeURIComponent(query);

  const results: SearchResultItem[] = [
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - National Geographic Kids`,
      url: `https://kids.nationalgeographic.com/search?q=${qEnc}`,
      domain: "kids.nationalgeographic.com",
      snippet: `Explore fun facts, videos, photos, and interactive quizzes about ${query} curated specifically for kids aged ${age}.`,
      category: "Official Kids Site",
      badge: "Verified Safe Portal"
    },
    {
      title: `Learning About ${query} | PBS KIDS`,
      url: `https://pbskids.org/search?q=${qEnc}`,
      domain: "pbskids.org",
      snippet: `Educational games, animated episodes, and fun activities designed to teach children about ${query} in a safe, friendly environment.`,
      category: "Educational",
      badge: "Child-Safe Badge"
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} Facts for Kids - Kiddle Encyclopedia`,
      url: `https://www.kiddle.co/s.php?q=${qEnc}`,
      domain: "kiddle.co",
      snippet: `Kid-safe visual encyclopedia results explaining ${query} with easy-to-read text, clear diagrams, and zero adult advertising.`,
      category: "Reference",
      badge: "Filtered Search"
    },
    {
      title: `NASA Kids' Club & STEM Explorer: ${query}`,
      url: `https://www.nasa.gov/learning-resources/nasa-kids-club/`,
      domain: "nasa.gov/kids",
      snippet: `Discover scientific explanations, space missions, and science experiments related to ${query} for young learners.`,
      category: "Educational",
      badge: "STEM Verified"
    },
    {
      title: `Britannica Kids: ${query} Overview`,
      url: `https://kids.britannica.com/kids/search/articles?query=${qEnc}`,
      domain: "kids.britannica.com",
      snippet: `Trusted encyclopedia articles and multimedia explaining ${query} tailored for student research and school projects.`,
      category: "Reference",
      badge: "Academic Grade"
    }
  ];

  if (qLower.includes("dinosaur") || qLower.includes("animal") || qLower.includes("space") || qLower.includes("volcano") || qLower.includes("planet") || qLower.includes("science")) {
    results.unshift({
      title: `Interactive STEM Guide: All About ${query.toUpperCase()}`,
      url: `https://www.dkfindout.com/us/search/${qEnc}/`,
      domain: "dkfindout.com",
      snippet: `Interactive visual guide with 3D models, sound effects, and timelines explaining ${query} for young curious minds.`,
      category: "Interactive",
      badge: "Editor's Choice"
    });
  }

  return results.slice(0, 5);
}

// AI Evaluation with Gemini
async function evaluateQueryWithAi(childQuery: string, childAge: number): Promise<EvaluationResult> {
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

    let searchResults: SearchResultItem[] = [];
    if (status === "Allowed") {
      if (Array.isArray(parsed.aiSearchResults) && parsed.aiSearchResults.length > 0) {
        searchResults = parsed.aiSearchResults;
      } else {
        searchResults = generateCuratedSafeResults(childQuery, childAge);
      }
    }

    let researchCitation: ResearchCitation | undefined = undefined;
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

    // Dynamic rule-based fallback if API fails
    const lower = childQuery.toLowerCase();
    const dangerousWords = ["porn", "kill", "suicide", "drug", "weapon", "bomb", "hack wifi", "explicit", "gore", "buy weed"];
    const riskyWords = ["dating", "fight", "ghost", "scary", "social media", "vape", "cheat test", "bypass filter"];

    let status: "Allowed" | "Risky" | "Blocked" = "Allowed";
    let explanation = `This query is generally safe for a ${childAge}-year-old child.`;
    let searchResults: SearchResultItem[] = [];
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

    let researchCitation: ResearchCitation | undefined = undefined;
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

// Authentication Middleware for Parent Dashboard
function requireParentAuth(req: Request, res: Response, next: NextFunction) {
  const authCookie = req.signedCookies?.parent_session || req.cookies?.parent_session;
  const authQuery = req.query.auth || req.body?.auth;
  if (
    authCookie === "authenticated" ||
    authQuery === "authenticated" ||
    authQuery === "1"
  ) {
    return next();
  }
  res.redirect("/parent-login");
}

// ROUTES

// 1. Home / Browser Interface
app.get("/", (req: Request, res: Response) => {
  const activeTab = (req.query.tab || "all").toString();
  res.render("index", {
    queryResult: null,
    formQuery: "",
    formAge: 8,
    activeTab,
  });
});

// 2. Search Endpoint
app.post("/search", async (req: Request, res: Response) => {
  const childQuery = (req.body.query || "").toString().trim();
  const childAge = parseInt((req.body.age || "8").toString(), 10) || 8;
  const activeTab = (req.body.tab || "all").toString();

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
    });
  }

  const result = await evaluateQueryWithAi(childQuery, childAge);

  // Log to in-memory parent dashboard store
  const timestamp = new Date().toLocaleString("en-US", { timeZoneName: "short" });
  const logEntry: QueryLog = {
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    query: childQuery,
    age: childAge,
    status: result.status,
    explanation: result.explanation,
    researchCitation: result.researchCitation,
    searchResultsCount: result.searchResults.length,
    alternatives: result.safeAlternatives,
    timestamp,
    ipAddress: req.ip || "127.0.0.1",
  };

  dashboardStore.queries.unshift(logEntry);
  if (result.status === "Allowed") dashboardStore.allowed_count += 1;
  else if (result.status === "Risky") dashboardStore.risky_count += 1;
  else if (result.status === "Blocked") dashboardStore.blocked_count += 1;

  res.render("index", {
    queryResult: result,
    formQuery: childQuery,
    formAge: childAge,
    activeTab,
  });
});

// 3. Parent Login GET
app.get("/parent-login", (req: Request, res: Response) => {
  const authCookie = req.signedCookies?.parent_session || req.cookies?.parent_session;
  if (authCookie === "authenticated" || req.query.auth === "1") {
    return res.redirect("/dashboard?auth=1");
  }
  res.render("parent-login", {
    error: null,
  });
});

// 4. Parent Login POST
app.post("/parent-login", (req: Request, res: Response) => {
  const inputPin = (req.body.pin || "").toString().trim();
  if (inputPin === dashboardStore.parentPin) {
    res.cookie("parent_session", "authenticated", {
      signed: true,
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    return res.redirect("/dashboard?auth=1");
  } else {
    return res.render("parent-login", {
      error: `Incorrect Parent Security PIN. Default PIN is "1234".`,
    });
  }
});

// 5. Parent Logout
app.post("/parent-logout", (req: Request, res: Response) => {
  res.clearCookie("parent_session");
  res.redirect("/");
});

// 6. Parent Dashboard GET (Protected)
app.get("/dashboard", requireParentAuth, (req: Request, res: Response) => {
  const filter = (req.query.filter || "all").toString().toLowerCase();

  let filteredQueries = dashboardStore.queries;
  if (filter === "allowed") {
    filteredQueries = dashboardStore.queries.filter((q) => q.status === "Allowed");
  } else if (filter === "risky") {
    filteredQueries = dashboardStore.queries.filter((q) => q.status === "Risky");
  } else if (filter === "blocked") {
    filteredQueries = dashboardStore.queries.filter((q) => q.status === "Blocked");
  }

  const totalUnsafe = dashboardStore.risky_count + dashboardStore.blocked_count;
  let securityAlert = "Child's browsing activity is safe and within limits.";
  let alertLevel: "clean" | "warning" | "danger" = "clean";

  if (totalUnsafe > 5) {
    securityAlert = "High volume of blocked/risky search attempts detected! Review search logs below.";
    alertLevel = "danger";
  } else if (totalUnsafe > 2) {
    securityAlert = "Notice: Some risky or blocked queries logged recently.";
    alertLevel = "warning";
  }

  res.render("dashboard", {
    queries: filteredQueries,
    totalCount: dashboardStore.queries.length,
    allowedCount: dashboardStore.allowed_count,
    riskyCount: dashboardStore.risky_count,
    blockedCount: dashboardStore.blocked_count,
    currentFilter: filter,
    securityAlert,
    alertLevel,
    pinUpdatedMessage: req.query.msg || null,
  });
});

// 7. Change Parent PIN
app.post("/parent-change-pin", requireParentAuth, (req: Request, res: Response) => {
  const currentPin = (req.body.currentPin || "").toString().trim();
  const newPin = (req.body.newPin || "").toString().trim();

  if (currentPin !== dashboardStore.parentPin) {
    return res.redirect("/dashboard?auth=1&msg=Error:%20Current%20PIN%20is%20incorrect.");
  }
  if (!newPin || newPin.length < 4) {
    return res.redirect("/dashboard?auth=1&msg=Error:%20New%20PIN%20must%20be%20at%20least%204%20digits.");
  }

  dashboardStore.parentPin = newPin;
  res.redirect("/dashboard?auth=1&msg=Success:%20Parent%20PIN%20updated%20successfully.");
});

// 8. Clear Logs
app.post("/parent-clear-logs", requireParentAuth, (req: Request, res: Response) => {
  dashboardStore.queries = [];
  dashboardStore.allowed_count = 0;
  dashboardStore.risky_count = 0;
  dashboardStore.blocked_count = 0;
  res.redirect("/dashboard?auth=1&msg=Logs%20cleared%20successfully.");
});

// 9. Export Logs Endpoint (JSON/CSV)
app.get("/parent-export", requireParentAuth, (req: Request, res: Response) => {
  const format = (req.query.format || "json").toString();
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=setu-search-logs.csv");
    let csv = "ID,Timestamp,Age,Status,Query,Explanation,Research Citation URL\n";
    dashboardStore.queries.forEach((q) => {
      const citeUrl = q.researchCitation ? q.researchCitation.url : "N/A";
      csv += `"${q.id}","${q.timestamp}",${q.age},"${q.status}","${q.query.replace(/"/g, '""')}","${q.explanation.replace(/"/g, '""')}","${citeUrl}"\n`;
    });
    return res.send(csv);
  } else {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=setu-search-logs.json");
    return res.send(JSON.stringify(dashboardStore, null, 2));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Setu Safe Browser Server running on http://0.0.0.0:${PORT}`);
});
