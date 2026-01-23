/**
 * SentencePiece Unigram tokenizer
 * Based on jax-js implementation
 */

import { fromBinary } from "@bufbuild/protobuf";
import {
  type ModelProto,
  ModelProto_SentencePiece_Type,
  ModelProtoSchema,
} from "sentencepiece-buf/model";

const SPIECE_UNDERLINE = "\u2581"; // ▁

interface TrieToken {
  id: number;
  score: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  token: TrieToken | null;
}

function createTrieNode(): TrieNode {
  return { children: new Map(), token: null };
}

/**
 * SentencePiece Unigram tokenizer.
 *
 * This implements the Viterbi-based unigram language model tokenization
 * algorithm used by SentencePiece.
 */
export class Unigram {
  #trie: TrieNode;
  #decoder: Map<number, string>;
  #byteFallback: Map<string, number>;
  #unkId: number;
  #bosId: number;
  #eosId: number;
  #addDummyPrefix: boolean;
  #removeExtraWhitespaces: boolean;

  constructor(model: ModelProto) {
    this.#trie = createTrieNode();
    this.#decoder = new Map();
    this.#byteFallback = new Map();

    this.#unkId = model.trainerSpec?.unkId ?? 0;
    this.#bosId = model.trainerSpec?.bosId ?? 1;
    this.#eosId = model.trainerSpec?.eosId ?? 2;

    this.#addDummyPrefix = model.normalizerSpec?.addDummyPrefix ?? true;
    this.#removeExtraWhitespaces =
      model.normalizerSpec?.removeExtraWhitespaces ?? true;

    for (let i = 0; i < model.pieces.length; i++) {
      const piece = model.pieces[i];
      const pieceStr = piece.piece;
      const score = piece.score;
      const type = piece.type;

      this.#decoder.set(i, pieceStr);

      if (type === ModelProto_SentencePiece_Type.BYTE) {
        const match = pieceStr.match(/^<0x([0-9A-Fa-f]{2})>$/);
        if (match) {
          this.#byteFallback.set(match[1].toLowerCase(), i);
        }
      } else if (
        type === ModelProto_SentencePiece_Type.NORMAL ||
        type === ModelProto_SentencePiece_Type.USER_DEFINED
      ) {
        this.#insertIntoTrie(pieceStr, i, score);
      }
    }
  }

  static fromBinary(data: Uint8Array): Unigram {
    const model = fromBinary(ModelProtoSchema, data);
    return new Unigram(model);
  }

  #insertIntoTrie(piece: string, id: number, score: number): void {
    let node = this.#trie;
    for (const char of piece) {
      let child = node.children.get(char);
      if (!child) {
        child = createTrieNode();
        node.children.set(char, child);
      }
      node = child;
    }
    node.token = { id, score };
  }

  #findPiecesAt(text: string, start: number): Array<[number, number, number]> {
    const results: Array<[number, number, number]> = [];
    let node = this.#trie;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      const child = node.children.get(char);
      if (!child) break;
      node = child;
      if (node.token) {
        results.push([i + 1, node.token.id, node.token.score]);
      }
    }

    return results;
  }

  #normalize(text: string): string {
    if (this.#removeExtraWhitespaces) {
      text = text.replace(/\s+/g, " ").trim();
    }
    if (text.length === 0) return "";
    if (this.#addDummyPrefix) {
      text = " " + text;
    }
    text = text.replace(/ /g, SPIECE_UNDERLINE);
    return text;
  }

  /**
   * Encode text into token IDs using Viterbi algorithm.
   */
  encode(text: string): number[] {
    const normalized = this.#normalize(text);
    if (normalized.length === 0) return [];

    const n = normalized.length;
    const NEG_INF = -1e18;

    // best[i] = best log probability to tokenize text[0:i]
    const best: number[] = new Array(n + 1).fill(NEG_INF);
    // backtrack[i] = (token_id, start_pos) for best path ending at i
    const backtrack: Array<[number, number] | null> = new Array(n + 1).fill(
      null
    );
    best[0] = 0;

    for (let i = 0; i < n; i++) {
      if (best[i] === NEG_INF) continue;

      const pieces = this.#findPiecesAt(normalized, i);

      if (pieces.length === 0) {
        // Byte fallback for unknown character
        const char = normalized[i];
        const bytes = new TextEncoder().encode(char);
        let currentPos = i;
        let currentScore = best[i];
        let valid = true;

        for (const byte of bytes) {
          const hex = byte.toString(16).padStart(2, "0");
          const byteId = this.#byteFallback.get(hex);
          if (byteId === undefined) {
            valid = false;
            break;
          }
          currentPos++;
          // Byte tokens typically have score 0
          if (currentScore > best[currentPos]) {
            best[currentPos] = currentScore;
            backtrack[currentPos] = [byteId, currentPos - 1];
          }
        }

        if (!valid && i + 1 <= n) {
          // Fall back to UNK token
          const newScore = best[i] + NEG_INF / 2;
          if (newScore > best[i + 1]) {
            best[i + 1] = newScore;
            backtrack[i + 1] = [this.#unkId, i];
          }
        }
      }

      for (const [end, tokenId, score] of pieces) {
        const newScore = best[i] + score;
        if (newScore > best[end]) {
          best[end] = newScore;
          backtrack[end] = [tokenId, i];
        }
      }
    }

    // Backtrack to get tokens
    const tokens: number[] = [];
    let pos = n;
    while (pos > 0) {
      const bt = backtrack[pos];
      if (!bt) break;
      const [tokenId, prevPos] = bt;
      tokens.push(tokenId);
      pos = prevPos;
    }

    tokens.reverse();
    return tokens;
  }

  /**
   * Decode token IDs back to text.
   */
  decode(tokens: number[]): string {
    const pieces: string[] = [];
    for (const id of tokens) {
      const piece = this.#decoder.get(id);
      if (piece) {
        pieces.push(piece);
      }
    }
    let text = pieces.join("");
    text = text.replace(new RegExp(SPIECE_UNDERLINE, "g"), " ");
    return text.trim();
  }
}

/**
 * Load a SentencePiece model from a URL.
 */
export async function loadSentencePiece(url: string): Promise<Unigram> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load tokenizer: ${response.statusText}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  return Unigram.fromBinary(data);
}
