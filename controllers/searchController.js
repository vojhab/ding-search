const { Pool } = require("pg");
const xss = require("xss");
const dotenv = require("dotenv");
require("@tensorflow/tfjs");
const use = require("@tensorflow-models/universal-sentence-encoder");
const { Configuration, OpenAIApi } = require("openai");

dotenv.config();

const modelPromise = use.load();

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

class SearchController {
  static async search(req, res) {
    let query = req.query.q;
    query = xss(query);

    const model = await modelPromise;

    let queryEmbedding = await model.embed(query);
    queryEmbedding = queryEmbedding.arraySync()[0];

    if (!query) {
      res.redirect("/");
      return;
    }

    if (query.length > process.env.MAX_QUERY_LENGTH) {
      res.redirect("/?tl=true");
      return;
    }

    const responsePromise = await openai.createCompletion({
      model: "text-babbage-001",
      prompt: `Correct this to standard English:\nOriginal: ${query}\nCorrected:`,
      temperature: 0,
      max_tokens: 50,
      stop: ["\n"],
    });

    const timeoutPromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error("Request timed out"));
      }, 1500);
    });

    let queryFixedSpelling = query;

    try {
      const response = await Promise.race([responsePromise, timeoutPromise]);
      queryFixedSpelling = response.data.choices[0].text;
      queryFixedSpelling = xss(queryFixedSpelling);
    } catch (error) {}

    const client = await pool.connect();

    const databaseQuery = {
      text: `SELECT * FROM websites ORDER BY embeddings <-> $1 LIMIT ${process.env.MAX_NUM_RESULTS};`,
      values: [JSON.stringify(queryEmbedding)],
    };

    const results = await client.query(databaseQuery);

    client.release();

    const safeResults = results.rows.map((result) => {
      return {
        id: result.id,
        title: xss(result.title),
        url: xss(result.url),
        description: xss(result.description),
        rank: result.rank,
      };
    });

    let fixedSpelling = false;

    if (queryFixedSpelling[0] == " ") {
      queryFixedSpelling = queryFixedSpelling.substring(1);
    }

    if (queryFixedSpelling[queryFixedSpelling.length - 1] == " ") {
      queryFixedSpelling = queryFixedSpelling.substring(
        0,
        queryFixedSpelling.length - 1
      );
    }

    if (queryFixedSpelling.toLowerCase() != query.toLowerCase()) {
      if (queryFixedSpelling.length > process.env.MAX_QUERY_LENGTH) {
      } else {
        if (queryFixedSpelling != "") {
          fixedSpelling = true;
        }
      }
    }

    res.render("search", {
      title: `${query} - Ding Search`,
      query: query,
      queryFixedSpelling: queryFixedSpelling,
      fixedSpelling: fixedSpelling,
      results: safeResults,
    });

    return;
  }
}

module.exports = SearchController;
