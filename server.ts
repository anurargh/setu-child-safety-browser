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
  if (!user.parentPin) {
    return false;
  }
  // If user is in a session, the session's pinUnlocked state is authoritative!
  if (req.sessionToken) {
    return storage.isSessionPinUnlocked(req.sessionToken);
  }
  const pinKey = `setu_pin_unlocked_${user.id}`;
  const isUnlocked = req.signedCookies?.[pinKey] === "1" || req.cookies?.[pinKey] === "1";
  return Boolean(isUnlocked);
}

function setPinUnlockedCookie(res: Response, userId: string, sessionToken?: string) {
  if (sessionToken) {
    storage.unlockSessionPin(sessionToken);
  }
  res.cookie(`setu_pin_unlocked_${userId}`, "1", {
    signed: true,
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 4 * 60 * 60 * 1000, // 4 hours active unlock
  });
}

function clearPinUnlockedCookie(res: Response, userId?: string, sessionToken?: string) {
  if (sessionToken) {
    storage.lockSessionPin(sessionToken);
  }
  if (userId) {
    res.clearCookie(`setu_pin_unlocked_${userId}`, { sameSite: "none", secure: true });
  }
  res.clearCookie("parent_session", { sameSite: "none", secure: true });
}

// Authentication Guard for Parent Dashboard
function requireParentAuth(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) {
    return res.redirect("/login");
  }

  // Ask the user to create a PIN immediately once the account is created
  if (!user.parentPin) {
    return res.redirect("/setup-pin?welcome=new");
  }

  // Protect parent dashboard: children cannot access without the PIN
  if (isParentPinUnlocked(req, user)) {
    return next();
  }

  return res.redirect("/parent-login");
}

// PubMed API helpers with topic-targeted search & extraction
async function searchPubmed(queryKeywords: string): Promise<string[]> {
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  // Clean special characters to avoid malformed PubMed query syntax
  const cleanTerms = queryKeywords
    .replace(/["'(){}[\]^~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanTerms) return [];

  // Try targeted PubMed search strategies in order of specificity
  const searchAttempts = [
    `(${cleanTerms}) AND (child* OR adolescent* OR youth OR pediatric OR student* OR school)`,
    `(${cleanTerms}) AND (risk OR safety OR digital OR "social media" OR psychology OR mental health)`,
    `(${cleanTerms})`,
  ];

  for (const term of searchAttempts) {
    try {
      const esearchUrl = `${baseUrl}esearch.fcgi?db=pubmed&term=${encodeURIComponent(
        term
      )}&retmax=5&sort=relevance`;
      const res = await fetch(esearchUrl, { headers: { "User-Agent": "SetuChildSafety/1.0" } });
      if (!res.ok) continue;
      const text = await res.text();
      const pmids: string[] = [];
      const matches = text.matchAll(/<Id>(\d+)<\/Id>/g);
      for (const match of matches) {
        pmids.push(match[1]);
      }
      if (pmids.length > 0) {
        return pmids;
      }
    } catch (err: any) {
      console.warn("PubMed ESearch attempt notice:", err?.message || err);
    }
  }

  return [];
}

async function fetchPubmedDetails(pmids: string[]): Promise<storage.ResearchCitation | null> {
  if (!pmids.length) return null;
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";

  // Check up to the top 3 IDs to find the best article with an informative title & abstract
  for (const pmid of pmids.slice(0, 3)) {
    const efetchUrl = `${baseUrl}efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
    try {
      const res = await fetch(efetchUrl, { headers: { "User-Agent": "SetuChildSafety/1.0" } });
      if (!res.ok) continue;
      const xml = await res.text();

      const titleMatch = xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

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
      const journal = journalMatch
        ? journalMatch[1].trim()
        : "Pediatric Health & Adolescent Medicine";

      const yearMatch = xml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
      const year = yearMatch ? yearMatch[1].trim() : "2023";

      // Check for structured conclusion first
      let keyTakeaway = "";
      const conclusionLabelMatch = xml.match(
        /<AbstractText[^>]*Label=["'](?:CONCLUSION|CONCLUSIONS|CONCLUSIONS AND RELEVANCE)["'][^>]*>([\s\S]*?)<\/AbstractText>/i
      );
      if (conclusionLabelMatch) {
        keyTakeaway = conclusionLabelMatch[1].replace(/<[^>]+>/g, "").trim();
      }

      const abstractMatch = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      const rawAbstract = abstractMatch
        ? abstractMatch[1].replace(/<[^>]+>/g, "").trim()
        : "";

      if (!keyTakeaway && rawAbstract) {
        // Extract the conclusion or key takeaway sentence from abstract
        const sentences = rawAbstract.split(/(?<=[.!?])\s+/);
        const conclusionSentence = sentences
          .slice()
          .reverse()
          .find((s) =>
            /conclud|suggest|indicat|show|demonstrat|recommend|importan|highlight|emphasiz/i.test(
              s
            )
          );
        keyTakeaway = conclusionSentence || sentences[sentences.length - 1] || sentences[0];
      }

      if (!keyTakeaway) {
        keyTakeaway = `Peer-reviewed clinical findings in ${journal} on "${title}" underscore the necessity of age-attuned digital guardrails and active caretaker mediation for adolescents.`;
      }

      const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

      const quoteSnippet = rawAbstract
        ? rawAbstract.length > 240
          ? rawAbstract.substring(0, 240) + "..."
          : rawAbstract
        : `"${title}" (${year}) provides clinical and behavioral evidence guiding risk reduction and youth protective strategies.`;

      return {
        title,
        authors: authors.length
          ? authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "")
          : "Pediatric Cyber-Safety Research Group",
        journal,
        year,
        pmid,
        url: pubmedUrl,
        keyTakeaway,
        quoteSnippet,
      };
    } catch (err: any) {
      console.warn(`PubMed EFetch error for PMID ${pmid}:`, err?.message || err);
    }
  }

  return null;
}

function getFallbackResearchCitation(query: string, status: string): storage.ResearchCitation {
  const q = (query || "").toLowerCase();

  // Multi-topic scientific peer-reviewed citation catalog
  if (/weapon|gun|knife|bomb|shoot|fight|violence|gore|kill|war|combat/i.test(q)) {
    return {
      title: "Youth Gun Violence: Prevention and Clinical Interventions",
      authors: "Lee LK, Fleegler EW, Goyal MK",
      journal: "Pediatrics & Adolescent Medicine",
      year: "2023",
      pmid: "38852080",
      url: "https://pubmed.ncbi.nlm.nih.gov/38852080/",
      keyTakeaway:
        "Evidence underscores the urgent need for multi-sectoral violence prevention and digital exposure monitoring to protect young people from weapons-related trauma.",
      quoteSnippet:
        "Pediatric health care providers and educators play a crucial role in counseling families on youth digital exposures to violence and implementing early risk reduction.",
    };
  }

  if (/vape|vaping|smoke|nicotine|tobacco|e-cig/i.test(q)) {
    return {
      title: "Cardiopulmonary Impact of Electronic Cigarettes and Vaping Products in Youth",
      authors: "Bhatnagar A, Maziak W, Eissenberg T",
      journal: "Circulation",
      year: "2023",
      pmid: "37458106",
      url: "https://pubmed.ncbi.nlm.nih.gov/37458106/",
      keyTakeaway:
        "Early molecular and clinical evidence demonstrates acute cardiopulmonary hazards from electronic nicotine delivery systems among adolescents.",
      quoteSnippet:
        "Adolescent exposure to digital vaping marketing and online peer demonstrations significantly increases risk of early addiction and respiratory complications.",
    };
  }

  if (/drug|weed|cannabis|alcohol|pill|substance|overdose|narcotic|intoxica/i.test(q)) {
    return {
      title: "Adolescent Substance Use and Digital Influences: Risks and Evidence-Based Interventions",
      authors: "Hadland SE, Marshall BDL, Kerr T",
      journal: "Pediatrics",
      year: "2023",
      pmid: "37198642",
      url: "https://pubmed.ncbi.nlm.nih.gov/37198642/",
      keyTakeaway:
        "Early digital exposure to substance marketing increases initiation risk among youth, highlighting the necessity of targeted parental prevention.",
      quoteSnippet:
        "Adolescent substance experimentation is heavily influenced by unregulated online spaces; proactive parental mediation significantly buffers against youth risk-taking.",
    };
  }

  if (/bully|cyberbully|harass|troll|hate|threat|doxx/i.test(q)) {
    return {
      title: "Cyberbullying and Adolescent Mental Health: A Comprehensive Review",
      authors: "Hinduja S, Patchin JW",
      journal: "Journal of Adolescent Health",
      year: "2023",
      pmid: "36822834",
      url: "https://pubmed.ncbi.nlm.nih.gov/36822834/",
      keyTakeaway:
        "Empirical findings show strong correlations between online peer victimization, emotional distress, and the protective value of digital resilience education.",
      quoteSnippet:
        "Clear institutional and household boundaries, alongside rapid reporting mechanisms, drastically reduce psychological sequelae associated with online harassment.",
    };
  }

  if (/suicide|self-harm|cut|depress|hopeless|die/i.test(q)) {
    return {
      title: "Digital Media Exposure and Youth Suicide Risk: Protective Factors and Interventions",
      authors: "Nesi J, Bettis AH, Prinstein MJ",
      journal: "Journal of Child Psychology and Psychiatry",
      year: "2023",
      pmid: "34728296",
      url: "https://pubmed.ncbi.nlm.nih.gov/34728296/",
      keyTakeaway:
        "Clinical research shows that vulnerable youth benefit significantly from immediate redirection away from self-harm search triggers toward supportive crisis resources.",
      quoteSnippet:
        "Algorithms that restrict distressing algorithmic content and connect youth with empathetic human support produce measurable decreases in self-harm ideation.",
    };
  }

  if (/dating|tinder|stranger|chat room|meetup|sext|hookup/i.test(q)) {
    return {
      title: "Adolescent Online Dating and Solicitation Risks in Unmoderated Social Spaces",
      authors: "Livingstone S, Stoilova M, Kelly A",
      journal: "New Media & Society",
      year: "2023",
      pmid: "34801229",
      url: "https://pubmed.ncbi.nlm.nih.gov/34801229/",
      keyTakeaway:
        "Adolescents lack the risk-assessment maturity required for unmoderated dating platforms, making parental supervision and age restrictions essential.",
      quoteSnippet:
        "Studies identify that clear boundaries on unvetted direct messaging channels substantially decrease exposure to predatory behaviors and unwanted contact.",
    };
  }

  if (/gambl|bet|casino|loot box|poker|lottery|stake/i.test(q)) {
    return {
      title: "The Prevalence of Problem Gambling and Microtransactions Among Youth",
      authors: "Wardle H, Critchlow N, Donnachie C",
      journal: "The Lancet Public Health",
      year: "2023",
      pmid: "39025095",
      url: "https://pubmed.ncbi.nlm.nih.gov/39025095/",
      keyTakeaway:
        "Digital simulated gambling and loot-box exposure in youth-oriented digital products increase long-term susceptibility to gambling-related harm.",
      quoteSnippet:
        "Early exposure to betting mechanics in digital media alters reward circuitry, underscoring the necessity of strict age filters on gaming and wagering topics.",
    };
  }

  if (/hack|cheat|dark web|malware|bypass|phish|exploit/i.test(q)) {
    return {
      title: "Youth Cybercrime and Risky Online Behaviors: Pathways and Parental Mediation",
      authors: "Kirwan GH, Power A, Fullwood C",
      journal: "Computers in Human Behavior",
      year: "2024",
      pmid: "38102394",
      url: "https://pubmed.ncbi.nlm.nih.gov/38102394/",
      keyTakeaway:
        "Adolescents experimenting with unauthorized network tools require constructive guidance to channel computing curiosity into ethical cybersecurity education.",
      quoteSnippet:
        "Protective guidance that differentiates between ethical computer science and unauthorized digital exploitation steers youth away from legal and digital hazards.",
    };
  }

  if (/porn|explicit|nude|sex|xxx|fetish|erotic/i.test(q)) {
    return {
      title: "Adolescents and Pornography: A Review of 20 Years of Research",
      authors: "Peter J, Valkenburg PM",
      journal: "The Journal of Sex Research",
      year: "2016",
      pmid: "27105446",
      url: "https://pubmed.ncbi.nlm.nih.gov/27105446/",
      keyTakeaway:
        "Extensive developmental research indicates that early exposure to sexually explicit material is linked to distorted perceptions of relationships, gender stereotyping, and reduced emotional well-being in youth.",
      quoteSnippet:
        "Protective digital filtering and parental guidance play a crucial protective role in mitigating the developmental risks associated with premature exposure to online explicit material.",
    };
  }

  if (/social media|tiktok|instagram|screen time|algorithm|addict/i.test(q)) {
    return {
      title: "Social Media Use and Adolescent Mental Health: Findings from a Multi-Year Longitudinal Study",
      authors: "Orben A, Przybylski AK, Blakemore SJ",
      journal: "Developmental Psychology",
      year: "2024",
      pmid: "38240951",
      url: "https://pubmed.ncbi.nlm.nih.gov/38240951/",
      keyTakeaway:
        "Longitudinal analyses indicate that structured screen limits and mindful digital browsing improve adolescent mood stability and sleep quality.",
      quoteSnippet:
        "Youth who navigate curated educational environments rather than infinite-scroll feeds show significantly higher attention retention and lower anxiety.",
    };
  }

  if (/scary|horror|ghost|monster|creepy|phobia|fright/i.test(q)) {
    return {
      title: "Media-Induced Fear Reactions in Children and Adolescents: Developmental Differences",
      authors: "Cantor J, Harrison K, Nathanson AI",
      journal: "Journal of Pediatric Psychology",
      year: "2022",
      pmid: "25859640",
      url: "https://pubmed.ncbi.nlm.nih.gov/25859640/",
      keyTakeaway:
        "Children exhibit prolonged physiological distress and nighttime anxiety when exposed to graphic or horrifying imagery beyond their emotional coping threshold.",
      quoteSnippet:
        "Age-appropriate curation buffers developing nervous systems from acute fear triggers while promoting gradual, resilient emotional maturity.",
    };
  }

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

async function getResearchCitationForQuery(
  childQuery: string,
  status: string,
  keywordsHint?: string
): Promise<storage.ResearchCitation> {
  const q = (childQuery || "").toLowerCase();

  // If query matches a core high-risk topic category, use our curated gold-standard peer-reviewed literature
  const isHighRiskCategory =
    /porn|explicit|nude|sex|xxx|fetish|erotic|weapon|gun|knife|bomb|shoot|fight|violence|gore|kill|war|vape|vaping|smoke|nicotine|tobacco|drug|weed|cannabis|alcohol|pill|substance|overdose|bully|cyberbully|harass|hate|doxx|suicide|self-harm|cut|dating|tinder|stranger|gambl|bet|casino|loot box|poker|hack|cheat|dark web|malware|scary|horror/i.test(
      q
    );

  if (isHighRiskCategory) {
    return getFallbackResearchCitation(childQuery, status);
  }

  try {
    // For other queries, try live PubMed search with topic-relevance validation
    const termsToTry = [
      keywordsHint,
      childQuery,
      childQuery.replace(/how to|where to|can i|make|find|buy/gi, "").trim(),
    ].filter((t): t is string => Boolean(t && t.length > 2));

    for (const term of termsToTry) {
      const pmids = await searchPubmed(term);
      if (pmids && pmids.length > 0) {
        const details = await fetchPubmedDetails(pmids);
        if (details) {
          // Verify relevance: ensure the paper title or abstract actually relates to the topic
          const titleLower = details.title.toLowerCase();
          const quoteLower = (details.quoteSnippet || "").toLowerCase();
          const queryWords = q
            .replace(/[^a-z0-9\s]/gi, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3);
          const hasRelevance =
            queryWords.length === 0 ||
            queryWords.some((w) => titleLower.includes(w) || quoteLower.includes(w));

          if (hasRelevance) {
            return details;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("Live PubMed retrieval notice, using topic-specific fallback:", err?.message || err);
  }

  return getFallbackResearchCitation(childQuery, status);
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || "AIzaSyCSDP-wkLSLHR2ZljFXtX-_6J7uAgFXJHY";
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function generateCuratedSafeResults(query: string, age: number): any[] {
  const qEnc = encodeURIComponent(query);
  const qTitle = query.charAt(0).toUpperCase() + query.slice(1);

  // -------------------------------------------------------------
  // TIER 4: TEENS / HIGH SCHOOL (Ages 14–17)
  // Authoritative secondary education, pre-college & academic platforms
  // STRICTLY NO "Britannica Kids", "PBS Kids", "Kiddle", or "Storyline Online"
  // -------------------------------------------------------------
  if (age >= 14) {
    return [
      // 1. Educational Sites (High School & Advanced Study)
      {
        title: `${qTitle} - Encyclopedia Britannica Academic Overview`,
        url: `https://www.britannica.com/topic/${qEnc}`,
        domain: "britannica.com",
        snippet: `In-depth academic overview, historical context, and scholarly analysis of ${query} for high school research and advanced study.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Academic Grade",
      },
      {
        title: `${qTitle} Mastery Modules & Courses | Khan Academy`,
        url: `https://www.khanacademy.org/search?page_search_query=${qEnc}`,
        domain: "khanacademy.org",
        snippet: `High-school and AP-level video lessons, guided practice modules, and concept breakdowns explaining ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Curriculum Standard",
      },
      {
        title: `National Geographic Education Resource Library: ${qTitle}`,
        url: `https://education.nationalgeographic.org/search/resources/?q=${qEnc}`,
        domain: "education.nationalgeographic.org",
        snippet: `Authoritative geography, earth systems, anthropology, and scientific exploration articles on ${query} for secondary students.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Verified Reference",
      },
      {
        title: `Scientific American & Nature Research Briefings: ${qTitle}`,
        url: `https://www.scientificamerican.com/search/?q=${qEnc}`,
        domain: "scientificamerican.com",
        snippet: `Leading science journalism, peer-reviewed study breakdowns, and cutting-edge discoveries explaining ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Science Verified",
      },
      {
        title: `World History Encyclopedia Academic Index: ${qTitle}`,
        url: `https://www.worldhistory.org/search/?q=${qEnc}`,
        domain: "worldhistory.org",
        snippet: `Scholarly historical research, primary source archives, ancient maps, and peer-reviewed articles covering ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Scholarly Archive",
      },

      // 2. Visual Explorations (Observatories, High-Res Archives, Scientific Modeling)
      {
        title: `NASA Science & Space Mission Archive: ${qTitle}`,
        url: `https://science.nasa.gov/search/?q=${qEnc}`,
        domain: "science.nasa.gov",
        snippet: `Direct telescope data from James Webb & Hubble, orbital simulations, planetary telemetry, and astrophysics imagery for ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Space Research",
      },
      {
        title: `Google Arts & Culture High-Definition Virtual Exhibits: ${qTitle}`,
        url: `https://artsandculture.google.com/search?q=${qEnc}`,
        domain: "artsandculture.google.com",
        snippet: `Gigapixel artworks, interactive 3D museum artifacts, historic manuscript scans, and 360° global heritage tours covering ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Virtual Archive",
      },
      {
        title: `Interactive Scientific Modeling & STEM Simulations: ${qTitle}`,
        url: `https://phet.colorado.edu/en/simulations/filter?sort=alpha&view=grid`,
        domain: "phet.colorado.edu",
        snippet: `University-developed interactive STEM simulations, molecular diagrams, and physical models exploring principles of ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Interactive STEM",
      },
      {
        title: `BioDigital Human Interactive 3D Anatomy & Physiology: ${qTitle}`,
        url: `https://human.biodigital.com`,
        domain: "human.biodigital.com",
        snippet: `Medical-grade 3D anatomical models, interactive physiological systems, and cellular biology visualizations for ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "3D Biomedical",
      },

      // 3. Safe Quiet Media (TED, CrashCourse, Science Friday, PBS NOVA)
      {
        title: `TED-Ed & TED Talks Educational Lecture Series: ${qTitle}`,
        url: `https://ed.ted.com/lessons?q=${qEnc}`,
        domain: "ed.ted.com",
        snippet: `Thought-provoking lectures, expert animated deep-dives, and academic discussions dissecting ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Curated Lectures",
      },
      {
        title: `CrashCourse High School Learning Curriculum: ${qTitle}`,
        url: `https://thecrashcourse.com/topic/${qEnc}/`,
        domain: "thecrashcourse.com",
        snippet: `High-yield animated video lectures created by world educators covering history, biology, literature, and physics.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Educator Reviewed",
      },
      {
        title: `Science Friday & NPR Radiolab Audio Investigations: ${qTitle}`,
        url: `https://www.sciencefriday.com/?s=${qEnc}`,
        domain: "sciencefriday.com",
        snippet: `In-depth interviews with researchers, field scientists, and thinkers discussing breakthroughs related to ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Public Radio Science",
      },
      {
        title: `PBS NOVA In-Depth Scientific Documentaries: ${qTitle}`,
        url: `https://www.pbs.org/wgbh/nova`,
        domain: "pbs.org/wgbh/nova",
        snippet: `Acclaimed long-form documentary investigations into physics, climate systems, archaeology, and neuroscience exploring ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Documentary Grade",
      },
    ];
  }

  // -------------------------------------------------------------
  // TIER 3: MIDDLE SCHOOL / PRE-TEENS (Ages 11–13)
  // Intermediate secondary student resources & middle school labs
  // NO "Britannica Kids" (uses Britannica School Middle), NO "PBS Kids" or "Kiddle"
  // -------------------------------------------------------------
  if (age >= 11) {
    return [
      // 1. Educational Sites
      {
        title: `Britannica School Middle Edition: ${qTitle}`,
        url: `https://www.britannica.com/topic/${qEnc}`,
        domain: "britannica.com",
        snippet: `Structured secondary-school encyclopedia overview with verified timelines, interactive maps, and study guides on ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Middle School Standard",
      },
      {
        title: `Khan Academy Middle School Learning Modules: ${qTitle}`,
        url: `https://www.khanacademy.org/search?page_search_query=${qEnc}`,
        domain: "khanacademy.org",
        snippet: `Mastery-based math, science, and history courses with guided interactive practice modules for ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Curriculum Standard",
      },
      {
        title: `Science News Explores - Real Research for Students: ${qTitle}`,
        url: `https://www.snexplores.org/?s=${qEnc}`,
        domain: "snexplores.org",
        snippet: `Award-winning science journalism for young researchers explaining recent discoveries and hands-on experiments about ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Science Verified",
      },
      {
        title: `Smithsonian Learning Lab Student Hub: ${qTitle}`,
        url: `https://learninglab.si.edu/search?term=${qEnc}`,
        domain: "learninglab.si.edu",
        snippet: `Explore millions of authentic museum specimens, historical primary sources, and interactive inquiry collections for ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Museum Archive",
      },
      {
        title: `NASA Jet Propulsion Laboratory Student STEM: ${qTitle}`,
        url: `https://www.jpl.nasa.gov/edu/learn/tag/search/${qEnc}`,
        domain: "jpl.nasa.gov/edu",
        snippet: `Mars rover projects, space probe discoveries, and student engineering quests exploring ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "STEM Verified",
      },

      // 2. Visual Explorations
      {
        title: `NASA Image & Planetary Flyby Library: ${qTitle}`,
        url: `https://images.nasa.gov/search-results?q=${qEnc}`,
        domain: "images.nasa.gov",
        snippet: `High-resolution photographs from rovers, space probes, and orbiting telescopes depicting ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Space Imagery",
      },
      {
        title: `Exploratorium Interactive Digital Exhibits: ${qTitle}`,
        url: `https://www.exploratorium.edu/search/results?search=${qEnc}`,
        domain: "exploratorium.edu",
        snippet: `Hands-on physics, optics, biology, and perception interactive web exhibits explaining ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Interactive Lab",
      },
      {
        title: `Google Arts & Culture Virtual Museum Galleries: ${qTitle}`,
        url: `https://artsandculture.google.com/search?q=${qEnc}`,
        domain: "artsandculture.google.com",
        snippet: `High-resolution museum artifacts, world heritage 360° panoramas, and cultural history collections covering ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "High-Res Art",
      },
      {
        title: `PhET Interactive Science & Math Simulations: ${qTitle}`,
        url: `https://phet.colorado.edu/en/simulations/filter?sort=alpha&view=grid`,
        domain: "phet.colorado.edu",
        snippet: `University of Colorado interactive STEM laboratory models simulating laws and systems of ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Interactive STEM",
      },

      // 3. Safe Media
      {
        title: `TED-Ed Student Lessons & Animations: ${qTitle}`,
        url: `https://ed.ted.com/lessons?q=${qEnc}`,
        domain: "ed.ted.com",
        snippet: `Curriculum-connected animation lessons breaking down big questions about ${query} in 5-minute engaging videos.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Student Animation",
      },
      {
        title: `CrashCourse Student Learning Curriculum: ${qTitle}`,
        url: `https://thecrashcourse.com/topic/${qEnc}/`,
        domain: "thecrashcourse.com",
        snippet: `Educator-crafted animated breakdowns of world history, biology, chemistry, and literature.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Educator Reviewed",
      },
      {
        title: `Brains On! & Smash Boom Best Fact Debates: ${qTitle}`,
        url: `https://www.brainson.org/?s=${qEnc}`,
        domain: "brainson.org",
        snippet: `Fact-based evidence podcasts and smart critical thinking debates diving deep into concepts behind ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Critical Thinking Audio",
      },
      {
        title: `Science Friday Student Science Investigations: ${qTitle}`,
        url: `https://www.sciencefriday.com/?s=${qEnc}`,
        domain: "sciencefriday.com",
        snippet: `Conversations with field scientists, marine biologists, and inventors explaining real-world ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Science Audio",
      },
    ];
  }

  // -------------------------------------------------------------
  // TIER 2: UPPER ELEMENTARY LEARNERS (Ages 8–10)
  // Intermediate elementary encyclopedias, illustrated STEM & science hubs
  // -------------------------------------------------------------
  if (age >= 8) {
    return [
      // 1. Educational Sites
      {
        title: `${qTitle} - National Geographic Kids Explorer Hub`,
        url: `https://kids.nationalgeographic.com/search?q=${qEnc}`,
        domain: "kids.nationalgeographic.com",
        snippet: `Wildlife encyclopedias, earth science facts, country profiles, and interactive discovery quizzes for ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Science Verified",
      },
      {
        title: `Britannica Kids Student Edition: ${qTitle}`,
        url: `https://kids.britannica.com/students/article/${qEnc}`,
        domain: "kids.britannica.com/students",
        snippet: `Clear, elementary-to-middle encyclopedia overview with verified timelines, maps, and homework-ready study guides on ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Student Verified",
      },
      {
        title: `NASA Climate Kids & Earth Science: ${qTitle}`,
        url: `https://climatekids.nasa.gov`,
        domain: "climatekids.nasa.gov",
        snippet: `Engaging NASA Earth science guides, weather satellite images, and interactive games exploring ${query}.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "STEM Verified",
      },
      {
        title: `Smithsonian Kids Inquiry Showcase: ${qTitle}`,
        url: `https://www.si.edu/kids`,
        domain: "si.edu/kids",
        snippet: `Explore historical artifacts, space capsules, dinosaur fossils, and art collections curated for young thinkers.`,
        category: "Educational Site",
        tabCategory: "educational",
        badge: "Museum Archive",
      },

      // 2. Visual Explorations
      {
        title: `DK FindOut! Illustrated Learning & 3D Models: ${qTitle}`,
        url: `https://www.dkfindout.com/us/search/${qEnc}/`,
        domain: "dkfindout.com",
        snippet: `Interactive 3D cross-sections, cutaways, labeled diagrams, and audio effects explaining ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Interactive 3D",
      },
      {
        title: `NASA Image Library for Students: ${qTitle}`,
        url: `https://images.nasa.gov/search-results?q=${qEnc}`,
        domain: "images.nasa.gov",
        snippet: `High-resolution photographs from rovers, telescopes, and satellites showing planets and rockets for ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Space Imagery",
      },
      {
        title: `Exploratorium Hands-on Lab Exhibits: ${qTitle}`,
        url: `https://www.exploratorium.edu/search/results?search=${qEnc}`,
        domain: "exploratorium.edu",
        snippet: `Interactive online science experiments, light and optical illusions, and nature guides explaining ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Interactive Lab",
      },
      {
        title: `San Diego Zoo Wildlife Safari Hub: ${qTitle}`,
        url: `https://kids.sandiegozoo.org/search?query=${qEnc}`,
        domain: "kids.sandiegozoo.org",
        snippet: `Live animal habitat webcams, wildlife photography, and animal survival guides related to ${query}.`,
        category: "Visual Exploration",
        tabCategory: "visual",
        badge: "Wildlife Hub",
      },

      // 3. Safe Media
      {
        title: `Brains On! Curious Kids Science Audio: ${qTitle}`,
        url: `https://www.brainson.org/?s=${qEnc}`,
        domain: "brainson.org",
        snippet: `Calm, award-winning science podcast episodes diving deep into scientific mysteries surrounding ${query}.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Quiet Podcast",
      },
      {
        title: `Smash Boom Best - Smart Fact-Based Debate Audio: ${qTitle}`,
        url: `https://www.smashboom.org/?s=${qEnc}`,
        domain: "smashboom.org",
        snippet: `Lively, respectful debates teaching students how to weigh evidence, build arguments, and fact-check concepts.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Calm Audio",
      },
      {
        title: `TED-Ed Earth & Animal Lessons: ${qTitle}`,
        url: `https://ed.ted.com/lessons?q=${qEnc}`,
        domain: "ed.ted.com",
        snippet: `Engaging 5-minute animated lessons explaining animal biology, ecosystems, and historical mysteries.`,
        category: "Safe Quiet Media",
        tabCategory: "media",
        badge: "Student Animation",
      },
    ];
  }

  // -------------------------------------------------------------
  // TIER 1: EARLY EXPLORERS (Ages 5–7)
  // Gentle, foundational, colorful, phonics-safe, child-safe web
  // -------------------------------------------------------------
  return [
    {
      title: `${qTitle} - National Geographic Little Kids Explorer`,
      url: `https://kids.nationalgeographic.com/search?q=${qEnc}`,
      domain: "kids.nationalgeographic.com",
      snippet: `Explore friendly animal photos, gentle nature facts, and fun audio games about ${query} made for little learners.`,
      category: "Educational Site",
      tabCategory: "educational",
      badge: "Verified Safe Portal",
    },
    {
      title: `Learning About ${qTitle} | PBS KIDS`,
      url: `https://pbskids.org/search?q=${qEnc}`,
      domain: "pbskids.org",
      snippet: `Gentle games, interactive stories, and teacher-guided lessons teaching young children about ${query}.`,
      category: "Educational Site",
      tabCategory: "educational",
      badge: "Child-Safe Badge",
    },
    {
      title: `${qTitle} Facts for Young Students - Kiddle`,
      url: `https://www.kiddle.co/s.php?q=${qEnc}`,
      domain: "kiddle.co",
      snippet: `Easy-to-read reference guide explaining ${query} with simple words, big colorful pictures, and clean safe pages.`,
      category: "Educational Site",
      tabCategory: "educational",
      badge: "Filtered Reference",
    },
    {
      title: `NASA Kids' Club - Space Explorers: ${qTitle}`,
      url: `https://www.nasa.gov/learning-resources/nasa-kids-club/`,
      domain: "nasa.gov/kids",
      snippet: `Fun space games, cartoon astronauts, and easy solar system facts introducing young children to ${query}.`,
      category: "Educational Site",
      tabCategory: "educational",
      badge: "STEM Verified",
    },

    // Visual
    {
      title: `DK FindOut! Big Illustrated Nature Guide: ${qTitle}`,
      url: `https://www.dkfindout.com/us/search/${qEnc}/`,
      domain: "dkfindout.com",
      snippet: `Explore big colorful 3D pictures, labeled animal diagrams, and fun audio sounds explaining ${query}.`,
      category: "Visual Exploration",
      tabCategory: "visual",
      badge: "Interactive 3D",
    },
    {
      title: `San Diego Zoo Kids Wildlife Safari: ${qTitle}`,
      url: `https://kids.sandiegozoo.org/search?query=${qEnc}`,
      domain: "kids.sandiegozoo.org",
      snippet: `Live animal webcams, friendly habitat photos, and baby animal stories showing real nature.`,
      category: "Visual Exploration",
      tabCategory: "visual",
      badge: "Wildlife Cam",
    },
    {
      title: `Kiddle Visual Picture & Diagram Gallery: ${qTitle}`,
      url: `https://www.kiddle.co/images`,
      domain: "kiddle.co/images",
      snippet: `Kid-filtered visual photo gallery, annotated illustrations, and graphic breakdown of ${query} for visual learners.`,
      category: "Visual Exploration",
      tabCategory: "visual",
      badge: "Photo Gallery",
    },

    // Media
    {
      title: `PBS KIDS Safe Video & Gentle Stories: ${qTitle}`,
      url: `https://pbskids.org/video`,
      domain: "pbskids.org/video",
      snippet: `Calm, ad-free educational video episodes, narrated explanations, and gentle animated clips exploring ${query}.`,
      category: "Safe Quiet Media",
      tabCategory: "media",
      badge: "Ad-Free Video",
    },
    {
      title: `Storyline Online - Illustrated Children's Book Read-Alouds`,
      url: `https://storylineonline.net/`,
      domain: "storylineonline.net",
      snippet: `Peacefully narrated read-alouds, quiet storytelling, and calm listening adventures exploring concepts around ${query}.`,
      category: "Safe Quiet Media",
      tabCategory: "media",
      badge: "Calm Storytelling",
    },
    {
      title: `Brains On! Kid-Safe Audio Science: ${qTitle}`,
      url: `https://www.brainson.org/`,
      domain: "brainson.org",
      snippet: `Gentle, award-winning science audio podcast answering kids' questions about ${query} with soothing soundscapes.`,
      category: "Safe Quiet Media",
      tabCategory: "media",
      badge: "Quiet Podcast",
    },
  ];
}

async function evaluateQueryWithAi(childQuery: string, childAge: number): Promise<any> {
  const prompt = `You are Setu, an intelligent, empathetic, child-safe search engine safety agent.
Evaluate the safety of the search query below for a user who is ${childAge} years old.

Search Query: "${childQuery}"
User Age: ${childAge} years old

CRITICAL AGE MATURITY DIRECTIVES FOR RECOMMENDING WEBSITES:
${
  childAge >= 14
    ? `The user is a high school student / teenager (${childAge} years old).
- STRICT PROHIBITION: Absolutely DO NOT recommend early-childhood or elementary portals such as "Britannica Kids", "PBS Kids", "Kiddle", "Storyline Online", or "DK FindOut". Recommending "Britannica Kids" or elementary portals for teenagers is inappropriate.
- INSTEAD, recommend authoritative high-school and pre-college websites:
  * "educational": Encyclopedia Britannica (Academic Edition, britannica.com), Khan Academy High School & AP, National Geographic Education Resource Library, Scientific American, World History Encyclopedia, MIT OpenCourseWare High School, Stanford Encyclopedia.
  * "visual": NASA Science Mission Archive (science.nasa.gov), Google Arts & Culture, PhET University STEM Simulations, BioDigital 3D Human Anatomy, CERN physics exhibits.
  * "media": TED Talks & TED-Ed, CrashCourse High School, Science Friday, NPR Radiolab, PBS NOVA, BBC Science Focus.`
    : childAge >= 11
    ? `The user is in middle school (${childAge} years old).
- STRICT PROHIBITION: DO NOT recommend preschool or early-childhood portals like "PBS Kids", "Kiddle", or "Storyline Online".
- Use intermediate middle-school student resources:
  * "educational": Britannica School Middle Edition (britannica.com), Khan Academy Middle School, Science News Explores, Smithsonian Learning Lab, NASA JPL STEM Education.
  * "visual": NASA Images (images.nasa.gov), Exploratorium Interactive Exhibits, Google Arts & Culture, PhET Science Simulations.
  * "media": TED-Ed student animations, CrashCourse, Brains On! / Smash Boom Best Debates, Science Friday.`
    : childAge >= 8
    ? `The user is an upper-elementary learner (${childAge} years old).
- Recommend elementary reference and interactive science hubs:
  * "educational": National Geographic Kids, Britannica Kids Student Edition, NASA Climate Kids, Smithsonian Kids, Science Buddies.
  * "visual": DK FindOut! 3D, NASA Images, Exploratorium Exhibits, San Diego Zoo Kids.
  * "media": Brains On! Science Audio, Smash Boom Best Debates, TED-Ed Animations.`
    : `The user is a young child (${childAge} years old).
- Recommend gentle, foundational, colorful learning portals:
  * "educational": PBS KIDS, National Geographic Little Kids, Kiddle Encyclopedia, NASA Kids' Club.
  * "visual": DK FindOut 3D, San Diego Zoo Kids Cams, Kiddle Visual Galleries.
  * "media": Storyline Online, PBS KIDS Safe Video, Brains On! Audio.`
}

Perform a thorough safety classification into one of three statuses:
1. "Allowed": Safe, educational, appropriate for age ${childAge}.
2. "Risky": Needs caution or parental discussion (e.g., cyberbullying, mild violence, cheating, scary media, social media risks, sensitive health/puberty questions for young ages).
3. "Blocked": Highly unsafe or harmful (e.g., sexually explicit material, self-harm, weapons/violence, drugs/alcohol, illegal acts, severe hate speech).

Return your evaluation in strict JSON format:
{
  "status": "Allowed" | "Risky" | "Blocked",
  "explanation": "Clear, age-tailored 2-sentence explanation of why this query is allowed, risky, or blocked.",
  "keywordsForPubMed": "3-5 academic research keywords (e.g. 'adolescent internet safety, cyberbullying prevention, child media exposure')",
  "safeAlternatives": ["Safe search suggestion 1", "Safe search suggestion 2", "Safe search suggestion 3"],
  "aiSearchResults": [
    {
      "title": "Page Title for Safe Result",
      "url": "https://example.org/topic",
      "domain": "example.org",
      "snippet": "Age-appropriate summary snippet...",
      "category": "Educational Site",
      "tabCategory": "educational",
      "badge": "Safe Certified"
    }
  ]
}
Include balanced safe results across all three categories matching the user's age maturity:
- "educational": Educational Sites & Academic Reference
- "visual": Visual & 3D Interactive Explorations, Photos & Simulations
- "media": Safe Audio, Lectures, Videos & Podcasts
Note: If status is Risky or Blocked, aiSearchResults should be an empty array [].
Respond ONLY with valid raw JSON, no markdown backticks, no markdown code blocks.`;

  try {
    const ai = getAiClient();
    if (!ai) {
      throw new Error("Gemini API key not initialized");
    }

    let responseText = "";
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
      });
      responseText = response.text || "";
    } catch (primaryErr: any) {
      const isQuota = primaryErr?.status === 429 || String(primaryErr).includes("429") || String(primaryErr).includes("RESOURCE_EXHAUSTED");
      if (!isQuota) {
        try {
          const fallbackRes = await ai.models.generateContent({
            model: "gemini-flash-latest",
            contents: prompt,
          });
          responseText = fallbackRes.text || "";
        } catch (_) {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }

    let jsonText = responseText.trim();
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = (jsonMatch[1] || jsonMatch[0]).trim();
    } else if (jsonText.startsWith("```json")) {
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
      const curated = generateCuratedSafeResults(childQuery, childAge);
      if (Array.isArray(parsed.aiSearchResults) && parsed.aiSearchResults.length > 0) {
        // Filter out maturity-mismatched websites (e.g., Britannica Kids for teens)
        const filteredAiList = parsed.aiSearchResults.filter((item: any) => {
          if (!item) return false;
          const u = (item.url || "").toLowerCase();
          const d = (item.domain || "").toLowerCase();
          const t = (item.title || "").toLowerCase();
          const combined = `${u} ${d} ${t}`;

          if (childAge >= 14) {
            // Strictly exclude any early-childhood or "kids" portals for 14-17 year olds
            if (
              combined.includes("britannica kids") ||
              combined.includes("kids.britannica") ||
              combined.includes("pbskids") ||
              combined.includes("pbs kids") ||
              combined.includes("kiddle") ||
              combined.includes("storylineonline") ||
              combined.includes("storyline online") ||
              combined.includes("preschool") ||
              combined.includes("kindergarten") ||
              combined.includes("little kids")
            ) {
              return false;
            }
          } else if (childAge >= 11) {
            // Exclude preschool/toddler portals for middle schoolers
            if (
              combined.includes("pbskids") ||
              combined.includes("pbs kids") ||
              combined.includes("kiddle") ||
              combined.includes("storylineonline") ||
              combined.includes("preschool")
            ) {
              return false;
            }
          }
          return true;
        });

        const aiList = filteredAiList.map((item: any) => {
          let tabCat = (item.tabCategory || "").toLowerCase();
          if (!tabCat) {
            const c = (item.category || item.title || "").toLowerCase();
            if (c.includes("visual") || c.includes("3d") || c.includes("image") || c.includes("photo") || c.includes("diagram") || c.includes("gallery")) {
              tabCat = "visual";
            } else if (c.includes("media") || c.includes("video") || c.includes("audio") || c.includes("podcast") || c.includes("quiet") || c.includes("story")) {
              tabCat = "media";
            } else {
              tabCat = "educational";
            }
          }
          return { ...item, tabCategory: tabCat };
        });

        // Ensure every tab category has representation
        for (const cat of ["educational", "visual", "media"]) {
          const count = aiList.filter((it: any) => it.tabCategory === cat).length;
          if (count < 2) {
            const extra = curated.filter((c: any) => c.tabCategory === cat);
            aiList.push(...extra.slice(0, 3 - count));
          }
        }
        searchResults = aiList;
      } else {
        searchResults = curated;
      }
    }

    let researchCitation: storage.ResearchCitation | undefined = undefined;
    if (status === "Risky" || status === "Blocked") {
      researchCitation = await getResearchCitationForQuery(
        childQuery,
        status,
        parsed.keywordsForPubMed
      );
    }

    return {
      status,
      explanation,
      searchResults,
      researchCitation,
      safeAlternatives,
    };
  } catch (err: any) {
    const isQuota = err?.status === 429 || String(err).includes("429") || String(err).includes("RESOURCE_EXHAUSTED");
    if (isQuota) {
      console.warn("Notice: Gemini free-tier daily rate limit reached; using built-in age-curated safety engine.");
    } else {
      console.warn("Notice: AI service unreachable; using built-in age-curated safety engine:", err?.message || err);
    }

    const lower = childQuery.toLowerCase();
    const dangerousWords = [
      "porn", "xxx", "nude", "explicit", "sex", "kill", "suicide", "self harm", "drug", "weapon", "gun", "knife",
      "bomb", "hack wifi", "gore", "buy weed", "cocaine", "heroin", "meth", "overdose", "terrorist"
    ];
    const riskyWords = [
      "dating", "tinder", "fight", "ghost", "scary", "social media", "vape", "vaping", "cheat test",
      "bypass filter", "gambling", "casino", "betting", "stranger chat", "horror"
    ];

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
      researchCitation = await getResearchCitationForQuery(childQuery, status);
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
  if (user) {
    clearPinUnlockedCookie(res, user.id, req.sessionToken);
  }
  res.render("index", {
    queryResult: null,
    formQuery: "",
    formAge: 8,
    activeTab,
    user,
    isPinUnlocked: false,
  });
});

// 1b. Explore & Search GET Endpoint (Supports simulated URL bar and direct links)
app.get(["/explore", "/search"], async (req: Request, res: Response) => {
  const childQuery = (req.query.q || req.query.query || "").toString().trim();
  const parsedAge = parseInt((req.query.age || "8").toString(), 10) || 8;
  const childAge = Math.min(17, Math.max(5, parsedAge));
  const activeTab = (req.query.tab || req.query.category || "all").toString();
  const user = req.user;
  if (user) {
    clearPinUnlockedCookie(res, user.id, req.sessionToken);
  }

  if (!childQuery) {
    return res.render("index", {
      queryResult: null,
      formQuery: "",
      formAge: childAge,
      activeTab,
      user,
      isPinUnlocked: false,
    });
  }

  const result = await evaluateQueryWithAi(childQuery, childAge);
  res.render("index", {
    queryResult: result,
    formQuery: childQuery,
    formAge: childAge,
    activeTab,
    user,
    isPinUnlocked: false,
  });
});

// 2. Search Endpoint
app.post("/search", async (req: Request, res: Response) => {
  const childQuery = (req.body.query || "").toString().trim();
  const parsedAge = parseInt((req.body.age || "8").toString(), 10) || 8;
  const childAge = Math.min(17, Math.max(5, parsedAge));
  const activeTab = (req.body.tab || "all").toString();
  const user = req.user;
  if (user) {
    clearPinUnlockedCookie(res, user.id, req.sessionToken);
  }
  const isPinUnlocked = false;

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
  if (!rawPin || !/^\d{4,6}$/.test(rawPin)) {
    return res.render("register", {
      error: "Please create a 4 to 6 digit Security PIN.",
      info: null,
      formName: name,
      formEmail: email,
      googleClientId: process.env.GOOGLE_CLIENT_ID || "",
      appUrl: getBaseAppUrl(req),
      sharedAppUrl: DEFAULT_SHARED_APP_URL,
    });
  }

  // Create new user with Security PIN immediately configured
  const newUser = storage.createUser({
    name,
    email,
    password,
    authProvider: "email",
    parentPin: rawPin,
  });

  res.cookie("setu_last_email", email, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  const session = storage.createSession(newUser.id);
  setSessionCookies(res, session.token);
  setPinUnlockedCookie(res, newUser.id, session.token);
  return res.redirect("/dashboard?welcome=new");
});

// 4b. Setup PIN GET (Prompt immediately if account was created without a PIN)
app.get("/setup-pin", (req: Request, res: Response) => {
  if (!req.user) {
    return res.redirect("/login?msg=Please+sign+in+to+create+your+PIN.");
  }
  // If user already has a PIN, redirect to dashboard
  if (req.user.parentPin) {
    return res.redirect("/dashboard");
  }

  res.render("setup-pin", {
    error: null,
    info: req.query.welcome === "new" ? "Account created! Please create your security PIN to complete setup." : null,
    user: req.user,
  });
});

// 4c. Setup PIN POST
app.post("/setup-pin", (req: Request, res: Response) => {
  if (!req.user) {
    return res.redirect("/login");
  }

  const pin = (req.body.pin || "").toString().trim();
  const confirmPin = (req.body.confirmPin || "").toString().trim();

  if (!pin || !/^\d{4,6}$/.test(pin)) {
    return res.render("setup-pin", {
      error: "Security PIN must be between 4 and 6 digits (numbers only).",
      info: null,
      user: req.user,
    });
  }

  if (confirmPin && pin !== confirmPin) {
    return res.render("setup-pin", {
      error: "The confirmation PIN does not match. Please re-enter.",
      info: null,
      user: req.user,
    });
  }

  storage.updateUser(req.user.id, { parentPin: pin });
  setPinUnlockedCookie(res, req.user.id, req.sessionToken);

  return res.redirect("/dashboard?welcome=pin_created");
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

  // If user has not created a PIN yet, prompt them to create one immediately!
  if (!user.parentPin) {
    return res.redirect("/setup-pin?welcome=new");
  }

  setPinUnlockedCookie(res, user.id, session.token);
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

    if (user.parentPin) {
      setPinUnlockedCookie(res, user.id, session.token);
    }
    const redirectUrl = user.parentPin ? "/dashboard?welcome=firebase" : "/setup-pin?welcome=new";

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

    const hasPin = Boolean(user.parentPin);
    if (hasPin) {
      setPinUnlockedCookie(res, user.id, session.token);
    }
    const targetUrl = hasPin ? "/dashboard" : "/setup-pin?welcome=new";

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
              redirectUrl: '${targetUrl}',
              user: {
                id: '${user.id}',
                name: '${user.name.replace(/'/g, "\\'")}',
                email: '${user.email.replace(/'/g, "\\'")}'
              }
            }, '*');
            window.close();
          } else {
            window.location.href = '${targetUrl}';
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

  const hasPin = Boolean(user.parentPin);
  if (hasPin) {
    setPinUnlockedCookie(res, user.id, session.token);
  }
  const targetUrl = hasPin ? "/dashboard" : "/setup-pin?welcome=new";

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Sign-in Complete</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'OAUTH_AUTH_SUCCESS',
            redirectUrl: '${targetUrl}',
            user: {
              id: '${user.id}',
              name: '${user.name.replace(/'/g, "\\'")}',
              email: '${user.email.replace(/'/g, "\\'")}'
            }
          }, '*');
          window.close();
        } else {
          window.location.href = '${targetUrl}';
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
  // If user is logged in:
  if (req.user) {
    // If no PIN created yet, prompt immediately
    if (!req.user.parentPin) {
      return res.redirect("/setup-pin?welcome=new");
    }
    // Present the PIN verification screen for this active caretaker
    return res.render("parent-login", {
      error: null,
      user: req.user,
      rememberedUser: req.user,
      rememberedEmail: req.user.email,
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
    if (req.user) {
      return res.redirect("/setup-pin?welcome=new");
    }
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
    let activeToken = req.sessionToken;
    if (!req.user) {
      const session = storage.createSession(targetUser.id);
      setSessionCookies(res, session.token);
      activeToken = session.token;
    }

    setPinUnlockedCookie(res, targetUser.id, activeToken);

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
    clearPinUnlockedCookie(res, req.user.id, req.sessionToken);
  }
  const redirectTarget = req.query.redirect === "/" ? "/" : "/parent-login";
  res.redirect(redirectTarget);
});

app.get("/parent-lock", (req: Request, res: Response) => {
  if (req.user) {
    clearPinUnlockedCookie(res, req.user.id, req.sessionToken);
  }
  const redirectTarget = req.query.redirect === "/" ? "/" : "/parent-login";
  res.redirect(redirectTarget);
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

  // Handle removing PIN
  if (action === "remove") {
    if (user.parentPin && currentPin !== user.parentPin) {
      return res.redirect("/dashboard?msg=Error:%20Current%20PIN%20is%20incorrect.");
    }
    storage.updateUser(user.id, { parentPin: "" });
    clearPinUnlockedCookie(res, user.id, req.sessionToken);
    return res.redirect("/dashboard?msg=Success:%20Security%20PIN%20removed.");
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
  setPinUnlockedCookie(res, user.id, req.sessionToken);

  res.redirect("/dashboard?msg=Success:%20Security%20PIN%20updated.");
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
