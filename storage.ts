import fs from "fs";
import path from "path";
import crypto from "crypto";
import { db, handleFirestoreError, OperationType } from "./firebaseConfig";
import { doc, setDoc, getDoc, collection, getDocs } from "firebase/firestore";

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

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash?: string;
  passwordSalt?: string;
  googleId?: string;
  avatar?: string;
  authProvider: "email" | "google" | "both";
  parentPin: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  pinUnlocked?: boolean;
}

export interface QueryLog {
  id: string;
  userId?: string;
  userEmail?: string;
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

export interface DatabaseSchema {
  users: User[];
  sessions: Session[];
  queries: QueryLog[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "setu_store.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory cache synced with disk
let db: DatabaseSchema = {
  users: [],
  sessions: [],
  queries: [],
};

// Seed initial log entries so the garden dashboard starts with rich demonstrable data
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

function loadDatabase(): void {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      db = JSON.parse(data);
      if (!Array.isArray(db.users)) db.users = [];
      if (!Array.isArray(db.sessions)) db.sessions = [];
      if (!Array.isArray(db.queries)) db.queries = [];
    } else {
      db = {
        users: [],
        sessions: [],
        queries: [...initialSeedQueries],
      };
      saveDatabase();
    }
  } catch (err) {
    console.error("Failed to load database file, initializing clean state:", err);
    db = {
      users: [],
      sessions: [],
      queries: [...initialSeedQueries],
    };
  }
}

function saveDatabase(): void {
  try {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), "utf-8");
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error("Failed to persist database file:", err);
  }
}

// Initialize on import
loadDatabase();

// Cryptographic Password Utils
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const storedKey = Buffer.from(hash, "hex");
    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch (err) {
    return false;
  }
}

// User CRUD operations
export function findUserByEmail(email: string): User | undefined {
  const normalized = (email || "").trim().toLowerCase();
  return db.users.find((u) => u.email.toLowerCase() === normalized);
}

export function findUserById(id: string): User | undefined {
  return db.users.find((u) => u.id === id);
}

export function findUserByGoogleId(googleId: string): User | undefined {
  return db.users.find((u) => u.googleId === googleId);
}

export function createUser(params: {
  name: string;
  email: string;
  password?: string;
  googleId?: string;
  avatar?: string;
  authProvider: "email" | "google" | "both";
  parentPin?: string;
}): User {
  const now = new Date().toISOString();
  const id = `usr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const normalizedEmail = params.email.trim().toLowerCase();

  let passwordHash: string | undefined = undefined;
  let passwordSalt: string | undefined = undefined;

  if (params.password) {
    const hashed = hashPassword(params.password);
    passwordHash = hashed.hash;
    passwordSalt = hashed.salt;
  }

  const defaultAvatar = params.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(normalizedEmail)}&backgroundColor=ebf2ec`;

  const user: User = {
    id,
    name: params.name.trim() || normalizedEmail.split("@")[0],
    email: normalizedEmail,
    passwordHash,
    passwordSalt,
    googleId: params.googleId,
    avatar: defaultAvatar,
    authProvider: params.authProvider,
    parentPin: (params.parentPin || "").trim(),
    createdAt: now,
    lastLoginAt: now,
  };

  db.users.push(user);
  saveDatabase();
  syncUserToFirestore(user).catch((err) =>
    console.warn("Firestore user sync background notice:", err?.message || err)
  );
  return user;
}

export async function syncUserToFirestore(user: User): Promise<void> {
  try {
    const userDocRef = doc(db, "users", user.id);
    await setDoc(
      userDocRef,
      {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar || "",
        authProvider: user.authProvider,
        parentPin: user.parentPin,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("Firestore syncUser warning:", error instanceof Error ? error.message : error);
  }
}

export async function syncQueryToFirestore(queryLog: QueryLog): Promise<void> {
  try {
    const queryDocRef = doc(db, "queries", queryLog.id);
    await setDoc(queryDocRef, {
      id: queryLog.id,
      userId: queryLog.userId || "",
      userEmail: queryLog.userEmail || "",
      query: queryLog.query,
      age: queryLog.age,
      status: queryLog.status,
      explanation: queryLog.explanation || "",
      searchResultsCount: queryLog.searchResultsCount || 0,
      timestamp: queryLog.timestamp,
      ipAddress: queryLog.ipAddress || "",
    });
  } catch (error) {
    console.warn("Firestore syncQuery warning:", error instanceof Error ? error.message : error);
  }
}

export function updateUser(id: string, updates: Partial<User>): User | null {
  const user = findUserById(id);
  if (!user) return null;

  Object.assign(user, updates);
  saveDatabase();
  syncUserToFirestore(user).catch((err) =>
    console.warn("Firestore user update sync background notice:", err?.message || err)
  );
  return user;
}

export function setUserPassword(id: string, newPassword: string): User | null {
  const user = findUserById(id);
  if (!user) return null;

  const { hash, salt } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  if (user.authProvider === "google") {
    user.authProvider = "both";
  }
  saveDatabase();
  return user;
}

export function linkGoogleToExistingUser(
  user: User,
  googleId: string,
  googleAvatar?: string
): User {
  user.googleId = googleId;
  if (googleAvatar && (!user.avatar || user.avatar.includes("dicebear"))) {
    user.avatar = googleAvatar;
  }
  user.authProvider = user.passwordHash ? "both" : "google";
  user.lastLoginAt = new Date().toISOString();
  saveDatabase();
  return user;
}

// Session Management
export function createSession(userId: string): Session {
  // 30 days session persistence
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const token = crypto.randomBytes(32).toString("hex");

  const session: Session = {
    token,
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  };

  // Remove stale sessions for this user if over 10
  const userSessions = db.sessions.filter((s) => s.userId === userId);
  if (userSessions.length > 10) {
    db.sessions = db.sessions.filter((s) => s.userId !== userId || s !== userSessions[0]);
  }

  db.sessions.push(session);
  saveDatabase();
  return session;
}

export function getSessionUser(token: string): User | null {
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;

  const expiresTime = new Date(session.expiresAt).getTime();
  if (Date.now() > expiresTime) {
    // Expired
    deleteSession(token);
    return null;
  }

  const user = findUserById(session.userId);
  if (!user) {
    deleteSession(token);
    return null;
  }

  return user;
}

export function deleteSession(token: string): void {
  db.sessions = db.sessions.filter((s) => s.token !== token);
  saveDatabase();
}

export function unlockSessionPin(token: string): void {
  const session = db.sessions.find((s) => s.token === token);
  if (session) {
    session.pinUnlocked = true;
    saveDatabase();
  }
}

export function lockSessionPin(token: string): void {
  const session = db.sessions.find((s) => s.token === token);
  if (session) {
    session.pinUnlocked = false;
    saveDatabase();
  }
}

export function isSessionPinUnlocked(token: string): boolean {
  if (!token) return false;
  const session = db.sessions.find((s) => s.token === token);
  return Boolean(session?.pinUnlocked);
}

export function deleteAllUserSessions(userId: string): void {
  db.sessions = db.sessions.filter((s) => s.userId !== userId);
  saveDatabase();
}

// Query logging
export function addQueryLog(log: Omit<QueryLog, "id">): QueryLog {
  const newLog: QueryLog = {
    ...log,
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  };
  db.queries.unshift(newLog);
  // Cap at 200 logs
  if (db.queries.length > 200) {
    db.queries = db.queries.slice(0, 200);
  }
  saveDatabase();
  syncQueryToFirestore(newLog).catch((err) =>
    console.warn("Firestore query sync notice:", err?.message || err)
  );
  return newLog;
}

export function getQueryLogs(userId?: string): QueryLog[] {
  if (userId) {
    const userLogs = db.queries.filter((q) => q.userId === userId);
    return userLogs.length > 0 ? userLogs : db.queries;
  }
  return db.queries;
}

export function clearQueryLogs(userId?: string): void {
  if (userId) {
    db.queries = db.queries.filter((q) => q.userId !== userId);
  } else {
    db.queries = [];
  }
  saveDatabase();
}

export function getAllUsersCount(): number {
  return db.users.length;
}

export function getAllUsers(): User[] {
  return [...db.users];
}
