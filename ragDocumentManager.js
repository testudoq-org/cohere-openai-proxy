// conversationManager.js
// RAGDocumentManager: Handles codebase indexing and retrieval for RAG
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const MemoryCache = require("./memoryCache");

class RAGDocumentManager {
  constructor(cohereClient) {
    this.cohere = cohereClient;
    this.documents = new Map(); // Document store
    this.embeddings = new Map(); // Embedding cache
    this.documentIndex = new Map(); // Index by file type/category
    this.embeddingCache = new MemoryCache(60 * 60 * 1000, 1000); // 1 hour TTL

    // Supported file extensions for codebase indexing
    this.supportedExtensions = new Set([
      ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".cpp", ".c", ".cs", ".php", ".rb", ".go", ".rs", ".swift", ".kt", ".scala", ".r", ".md", ".txt", ".json", ".yml", ".yaml", ".xml", ".html", ".css", ".sql", ".sh", ".bat", ".ps1", ".dockerfile", ".env"
    ]);
  }

  // Index a directory/codebase
  async indexCodebase(projectPath, options = {}) {
    const {
      maxFileSize = 500 * 1024,
      excludeDirs = ["node_modules", ".git", "dist", "build", "coverage"],
      includeTests = true,
    } = options;

    console.log(`[RAG] Starting codebase indexing for: ${projectPath}`);
    let indexedCount = 0;
    let skippedCount = 0;

    try {
      const files = await this.scanDirectory(projectPath, excludeDirs);

      for (const filePath of files) {
        try {
          const stat = await fs.stat(filePath);

          // Skip large files
          if (stat.size > maxFileSize) {
            skippedCount++;
            continue;
          }

          const ext = path.extname(filePath).toLowerCase();
          if (!this.supportedExtensions.has(ext)) {
            skippedCount++;
            continue;
          }

          // Skip test files if not included
          if (!includeTests && this.isTestFile(filePath)) {
            skippedCount++;
            continue;
          }

          await this.indexFile(filePath);
          indexedCount++;

          // Rate limiting to avoid API limits
          if (indexedCount % 10 === 0) {
            await this.sleep(1000);
          }
        } catch (error) {
          console.error(
            `[RAG] Error indexing file ${filePath}:`,
            error.message
          );
          skippedCount++;
        }
      }

      console.log(
        `[RAG] Indexing complete. Indexed: ${indexedCount}, Skipped: ${skippedCount}`
      );
      return { indexedCount, skippedCount, totalFiles: files.length };
    } catch (error) {
      console.error("[RAG] Codebase indexing failed:", error);
      throw error;
    }
  }

  // Index a single file
  async indexFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const relativePath = path.relative(process.cwd(), filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Extract metadata
      const metadata = {
        filePath: relativePath,
        fullPath: filePath,
        fileType: ext,
        size: content.length,
        lastModified: (await fs.stat(filePath)).mtime,
        language: this.detectLanguage(ext),
        category: this.categorizeFile(filePath),
        functions: this.extractFunctions(content, ext),
        classes: this.extractClasses(content, ext),
        imports: this.extractImports(content, ext),
      };

      // Split large files into chunks
      const chunks = this.splitIntoChunks(content, 1000);

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${relativePath}:chunk:${i}`;
        const chunkMetadata = {
          ...metadata,
          chunkIndex: i,
          totalChunks: chunks.length,
          chunkId,
        };

        // Store document
        this.documents.set(chunkId, {
          id: chunkId,
          content: chunks[i],
          metadata: chunkMetadata,
          timestamp: Date.now(),
        });

        // Add to category index
        this.addToIndex(chunkMetadata.category, chunkId);
        this.addToIndex(chunkMetadata.language, chunkId);
      }

      console.log(
        `[RAG] Indexed file: ${relativePath} (${chunks.length} chunks)`
      );
    } catch (error) {
      console.error(`[RAG] Failed to index file ${filePath}:`, error.message);
      throw error;
    }
  }

  // Retrieve relevant documents for a query
  async retrieveRelevantDocuments(query, options = {}) {
    const {
      maxResults = 5,
      minSimilarity = 0.3,
      fileTypes = [],
      categories = [],
      useSemanticSearch = true,
      useKeywordSearch = true,
    } = options;

    console.log(
      `[RAG] Retrieving documents for query: "${query.substring(0, 100)}..."`
    );

    let results = [];
    let semanticError = null;
    let semanticAttempted = false;

    // Helper for timeout
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Semantic search timeout")), ms)
        ),
      ]);
    }

    // Semantic search with timeout and fallback
    if (useSemanticSearch && this.documents.size > 0) {
      semanticAttempted = true;
      try {
        const semanticResults = await withTimeout(
          this.semanticSearch(query, {
            maxResults: maxResults * 2,
            minSimilarity,
          }),
          5000
        );
        results = results.concat(semanticResults);
      } catch (error) {
        semanticError = error;
        console.error("[RAG] Semantic search failed or timed out, falling back:", error.message);
      }
    }

    // Keyword search fallback if semantic search failed or not enough results
    if (
      useKeywordSearch &&
      (!semanticAttempted || semanticError || results.length < maxResults)
    ) {
      const keywordResults = this.keywordSearch(query, {
        maxResults: maxResults * 2,
        fileTypes,
        categories,
      });
      results = results.concat(keywordResults);
    }

    // Remove duplicates and sort by relevance
    const uniqueResults = this.deduplicateResults(results);
    const rankedResults = this.rankResults(uniqueResults, query);

    const finalResults = rankedResults.slice(0, maxResults);

    console.log(`[RAG] Retrieved ${finalResults.length} relevant documents`);

    return finalResults.map((result) => ({
      content: result.document.content,
      metadata: result.document.metadata,
      relevanceScore: result.score,
      matchType: result.matchType,
    }));
  }

  // Semantic search using Cohere embeddings
  async semanticSearch(query, options = {}) {
    const { maxResults = 10, minSimilarity = 0.3 } = options;

    try {
      // Get query embedding
      const queryEmbedding = await this.getEmbedding(query);
      const results = [];

      // Compare with document embeddings
      for (const [docId, document] of this.documents) {
        const docEmbedding = await this.getEmbedding(document.content);
        const similarity = this.cosineSimilarity(queryEmbedding, docEmbedding);

        if (similarity >= minSimilarity) {
          results.push({
            document,
            score: similarity,
            matchType: "semantic",
          });
        }
      }

      // Sort by similarity
      return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
    } catch (error) {
      console.error("[RAG] Semantic search failed:", error);
      return [];
    }
  }

  // Keyword-based search
  keywordSearch(query, options = {}) {
    const { maxResults = 10, fileTypes = [], categories = [] } = options;
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const results = [];

    for (const [docId, document] of this.documents) {
      const content = document.content.toLowerCase();
      const metadata = document.metadata;

      // Filter by file type/category if specified
      if (fileTypes.length > 0 && !fileTypes.includes(metadata.fileType))
        continue;
      if (categories.length > 0 && !categories.includes(metadata.category))
        continue;

      // Calculate keyword match score
      let score = 0;
      let matches = 0;

      for (const term of queryTerms) {
        const termCount = (content.match(new RegExp(term, "g")) || []).length;
        if (termCount > 0) {
          score += termCount * (term.length / query.length);
          matches++;
        }
      }

      if (matches > 0) {
        score = (matches / queryTerms.length) * (score / content.length) * 1000;
        results.push({
          document,
          score,
          matchType: "keyword",
          matchedTerms: matches,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  // Get embedding for text (with caching)
  async getEmbedding(text) {
    const textHash = crypto.createHash("md5").update(text).digest("hex");
    const cached = this.embeddingCache.get(textHash);

    if (cached) {
      return cached;
    }

    const maxAttempts = 3;
    const backoffTimes = [1000, 3000, 9000];
    let lastErrorMsg = null;
    let sameErrorCount = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          console.warn(`[RETRY] Attempt ${attempt} for embedding generation...`);
          await this.sleep(backoffTimes[attempt - 2]);
        }
        const response = await this.cohere.embed({
          texts: [text],
          model: "embed-english-v3.0",
          input_type: "search_document",
        });

        const embedding = response.embeddings[0];
        this.embeddingCache.set(textHash, embedding);

        return embedding;
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (errorMsg === lastErrorMsg) {
          sameErrorCount++;
        } else {
          sameErrorCount = 1;
          lastErrorMsg = errorMsg;
        }
        if (sameErrorCount >= 2) {
          console.error("[CIRCUIT BREAKER] Same embedding error twice, aborting.");
          break;
        }
        if (attempt === maxAttempts) {
          console.error("[CIRCUIT BREAKER] Max attempts reached for embedding generation.");
          break;
        }
        console.error(`[ERROR] Embedding generation attempt ${attempt} failed:`, errorMsg);
      }
    }
    // Fallback: return null
    return null;
  }

  // Helper methods
  async scanDirectory(dir, excludeDirs = []) {
    const files = [];
    const items = await fs.readdir(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        if (!excludeDirs.includes(item) && !item.startsWith(".")) {
          files.push(...(await this.scanDirectory(fullPath, excludeDirs)));
        }
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  splitIntoChunks(text, chunkSize = 1000) {
    const chunks = [];
    const sentences = text.split(/[.!?]+/);
    let currentChunk = "";

    for (const sentence of sentences) {
      if (
        currentChunk.length + sentence.length > chunkSize &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence + ".";
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  detectLanguage(ext) {
    const langMap = {
      ".js": "javascript",
      ".ts": "typescript",
      ".jsx": "react",
      ".py": "python",
      ".java": "java",
      ".cpp": "cpp",
      ".c": "c",
      ".cs": "csharp",
      ".php": "php",
      ".rb": "ruby",
      ".go": "go",
      ".rs": "rust",
      ".swift": "swift",
      ".kt": "kotlin",
      ".scala": "scala",
    };
    return langMap[ext] || "text";
  }

  categorizeFile(filePath) {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    if (fileName.includes("test") || dirName.includes("test")) return "test";
    if (fileName.includes("config") || fileName.includes("env"))
      return "config";
    if (fileName === "readme.md" || fileName.includes("doc"))
      return "documentation";
    if (dirName.includes("api") || dirName.includes("route")) return "api";
    if (dirName.includes("component") || dirName.includes("ui"))
      return "component";
    if (dirName.includes("util") || dirName.includes("helper"))
      return "utility";
    if (dirName.includes("model") || dirName.includes("schema")) return "model";

    return "source";
  }

  isTestFile(filePath) {
    const fileName = path.basename(filePath).toLowerCase();
    return (
      fileName.includes("test") ||
      fileName.includes("spec") ||
      fileName.endsWith(".test.js") ||
      fileName.endsWith(".spec.js")
    );
  }

  extractFunctions(content, ext) {
    const patterns = {
      ".js": /(?:function\s+(\w+)|(\w+)\s*[=:]\s*(?:function|\([^)]*\)\s*=>))/g,
      ".py": /def\s+(\w+)\s*\(/g,
      ".java":
        /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/g,
    };

    const pattern = patterns[ext];
    if (!pattern) return [];

    const matches = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1] || match[2]);
    }
    return matches;
  }

  extractClasses(content, ext) {
    const patterns = {
      ".js": /class\s+(\w+)/g,
      ".py": /class\s+(\w+)/g,
      ".java": /class\s+(\w+)/g,
    };

    const pattern = patterns[ext];
    if (!pattern) return [];

    const matches = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1]);
    }
    return matches;
  }

  extractImports(content, ext) {
    const patterns = {
      ".js":
        /(?:import.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g,
      ".py": /(?:import\s+(\w+)|from\s+(\w+)\s+import)/g,
    };

    const pattern = patterns[ext];
    if (!pattern) return [];

    const matches = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1] || match[2]);
    }
    return matches;
  }

  addToIndex(category, docId) {
    if (!this.documentIndex.has(category)) {
      this.documentIndex.set(category, new Set());
    }
    this.documentIndex.get(category).add(docId);
  }

  deduplicateResults(results) {
    const seen = new Set();
    return results.filter((result) => {
      const id = result.document.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  rankResults(results, query) {
    return results
      .map((result) => ({
        ...result,
        score: result.score * this.calculateBoostFactor(result.document, query),
      }))
      .sort((a, b) => b.score - a.score);
  }

  calculateBoostFactor(document, query) {
    let boost = 1.0;
    const metadata = document.metadata;

    if (metadata.category === "documentation") boost *= 1.2;
    if (metadata.category === "api") boost *= 1.1;

    const daysSinceModified =
      (Date.now() - new Date(metadata.lastModified)) / (1000 * 60 * 60 * 24);
    if (daysSinceModified < 7) boost *= 1.1;

    return boost;
  }

  cosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Get indexing stats
  getStats() {
    return {
      totalDocuments: this.documents.size,
      totalEmbeddings: this.embeddings.size,
      categories: Array.from(this.documentIndex.keys()),
      cacheStats: {
        embeddingCacheSize: this.embeddingCache.cache.size,
      },
    };
  }

  // Clear all indexed documents
  clearIndex() {
    this.documents.clear();
    this.embeddings.clear();
    this.documentIndex.clear();
    this.embeddingCache.clear();
    console.log("[RAG] Document index cleared");
  }

  // Get documents by category
  getDocumentsByCategory(category) {
    const docIds = this.documentIndex.get(category) || new Set();
    return Array.from(docIds)
      .map((id) => this.documents.get(id))
      .filter(Boolean);
  }
}

module.exports = RAGDocumentManager;