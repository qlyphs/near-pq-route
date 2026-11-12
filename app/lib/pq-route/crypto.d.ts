/** Types for crypto.js (payment requests, fresh ML-DSA-65 accounts, encrypted receipts). */
export interface RouteWallet { seed: Uint8Array; kem: { publicKey: Uint8Array; secretKey: Uint8Array }; id: { publicKey: Uint8Array; secretKey: Uint8Array }; spendRoot: Uint8Array; scanRoot: Uint8Array }
export interface Card { v: number; kem: string; id: string }
export interface PaymentRequest { v: number; network: string; account: string; accountKey: string; amount: string; memo: string; expiresAt?: number; receipt: string; recipient: Card }
export interface Signer65 { publicKey: string; publicKeyHandle: string; destroy(): void; [k: string]: unknown }
export const VERSION: number;
export const RECEIPT_LEN: number;
export function hex(b: Uint8Array): string;
export function unhex(s: string): Uint8Array;
export function wallet(seed: Uint8Array): RouteWallet;
export function card(w: RouteWallet): Card;
export function cardFingerprint(c: Card): string;
export function cardPin(c: Card): string;
export function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean;
export function receiptKeyFor(w: RouteWallet, network: string, rid: Uint8Array): Uint8Array;
export function paymentKeys(w: RouteWallet, network: string, rid: Uint8Array): { signer: Signer65; receiptKey: Uint8Array };
export function accountFor(publicKey: string | Uint8Array, sponsor: string): string;
export function sealReceipt(receiptKey: Uint8Array, rid: Uint8Array, body: object): Uint8Array;
export function openReceipt(w: RouteWallet, network: string, receipt: Uint8Array): { rid: Uint8Array; body: any } | null;
export function createRequest(w: RouteWallet, payerCard: Card, o: { network: string; sponsor: string; amountPlanck: bigint; memo?: string; expiresAt?: number }): { sealed: Uint8Array; rid: Uint8Array; account: string };
export function openRequest(payer: RouteWallet, sealed: Uint8Array, o: { recipient: Card; network: string; sponsor: string; now?: number }): PaymentRequest;
export function openRequestPinned(payer: RouteWallet, sealed: Uint8Array, o: { pin: string; network: string; sponsor: string; now?: number }): PaymentRequest;
export function findPayments(w: RouteWallet, network: string, receipts: Uint8Array[], sponsor?: string): { rid: Uint8Array; body: any; receipt: Uint8Array }[];
