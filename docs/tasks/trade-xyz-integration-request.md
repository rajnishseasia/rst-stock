# Standalone guide: fund Hyperliquid from Solana or EVM wallets

This guide is independent of any existing application. It provides reusable TypeScript for:

- Sending native SOL from Solana to a Hyperliquid account through Unit.
- Depositing native Arbitrum USDC into Hyperliquid's canonical bridge.
- Adding native ETH on Ethereum through a route-provider adapter.
- Tracking deposits safely in a backend database.

## Important distinction

These are three different routes:

| Source | Route | Destination |
|---|---|---|
| SOL on Solana | Unit deposit address | Hyperliquid spot balance as SOL |
| Native USDC on Arbitrum | Hyperliquid canonical bridge | Hyperliquid account associated with the depositing EVM address |
| ETH on Ethereum | External cross-chain route provider | Provider-defined Hyperliquid destination |

Native ETH cannot be sent directly to Hyperliquid's Arbitrum USDC bridge. It must be swapped and bridged by a provider that explicitly supports Hyperliquid funding.

## Dependencies

Frontend:

```bash
npm install ethers @solana/web3.js @solana/wallet-adapter-react
```

Backend:

```bash
npm install express ethers pg zod
```

The examples assume TypeScript and Node 18 or newer, where `fetch` is globally available.

## Environment variables

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/app
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
ARBITRUM_GAS_PAYER_PRIVATE_KEY=0x...

# Only needed for an Ethereum ETH route provider:
CROSS_CHAIN_PROVIDER_API_URL=https://provider.example
CROSS_CHAIN_PROVIDER_API_KEY=...
```

Never expose private keys or provider API keys to frontend code.

---

# Shared types

```ts
export type FundingStatus =
  | 'quoted'
  | 'submitted'
  | 'source_confirmed'
  | 'bridging'
  | 'destination_confirmed'
  | 'completed'
  | 'failed'
  | 'refunded'

export type FundingChain = 'solana' | 'ethereum' | 'arbitrum'
export type FundingAsset = 'SOL' | 'ETH' | 'USDC'

export type FundingQuoteInput = {
  sourceChain: FundingChain
  sourceAsset: FundingAsset
  sourceAmount: string
  sourceWallet: string
  hyperliquidDestination: string
  slippageBps?: number
}

export type FundingRoute = {
  provider: 'unit' | 'hyperliquid-bridge' | 'cross-chain-provider'
  routeId: string
  expiresAt?: string
  estimatedOutput?: string
  depositAddress?: string
  transaction?: {
    chain: FundingChain
    to?: string
    data?: string
    value?: string
    gasLimit?: string
    serializedTransaction?: string
  }
}
```

Always represent token amounts as decimal strings or integer smallest-unit strings. Avoid JavaScript floating-point values for settlement.

---

# Route 1: SOL on Solana through Unit

## How it works

1. Ask Unit for a Solana deposit address associated with the user's Hyperliquid EVM address.
2. Send native SOL from the connected Solana wallet to that Unit address.
3. Record and verify the transaction on the backend.
4. Poll until the funds appear in the user's Hyperliquid spot balance.

Unit returns SOL to Hyperliquid spot. Converting it to USDC or moving funds to perps is a separate Hyperliquid trading/account-transfer operation.

## Unit client

```ts
const UNIT_API_URL = 'https://api.hyperunit.xyz'

export async function getUnitSolDepositAddress(
  hyperliquidAddress: string,
): Promise<string> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(hyperliquidAddress)) {
    throw new Error('Invalid Hyperliquid EVM address')
  }

  const url =
    `${UNIT_API_URL}/gen/solana/hyperliquid/sol/` +
    encodeURIComponent(hyperliquidAddress)

  const response = await fetch(url)
  const body = await response.json()

  if (!response.ok || !body.address) {
    throw new Error(body.error || 'Unit did not return a deposit address')
  }

  return body.address
}

export async function getUnitSolDepositFee(): Promise<string | null> {
  const response = await fetch(`${UNIT_API_URL}/v2/estimate-fees`)
  const body = await response.json()

  if (!response.ok) {
    throw new Error(body.error || 'Unable to fetch Unit fees')
  }

  return body.solana?.depositFee?.toString() ?? null
}
```

Generate the address on the backend when possible. That lets the backend derive `hyperliquidAddress` from the authenticated user rather than trusting an address sent by the browser.

## Convert decimal SOL to lamports safely

```ts
const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n

export function solToLamports(amount: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(amount)) {
    throw new Error('SOL amount must have at most 9 decimal places')
  }

  const [whole, fraction = ''] = amount.split('.')
  const paddedFraction = fraction.padEnd(9, '0')

  return (
    BigInt(whole) * LAMPORTS_PER_SOL_BIGINT +
    BigInt(paddedFraction)
  )
}
```

## Browser transaction

This function accepts the wallet-adapter values returned by `useWallet()` and `useConnection()`:

```ts
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'

type SendTransaction = (
  transaction: Transaction,
  connection: Connection,
) => Promise<string>

export async function sendSolToUnit(params: {
  connection: Connection
  publicKey: PublicKey
  sendTransaction: SendTransaction
  unitDepositAddress: string
  amountSol: string
}): Promise<string> {
  const {
    connection,
    publicKey,
    sendTransaction,
    unitDepositAddress,
    amountSol,
  } = params

  const lamports = solToLamports(amountSol)
  if (lamports <= 0n) throw new Error('Amount must be positive')
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount is too large for SystemProgram.transfer')
  }

  const destination = new PublicKey(unitDepositAddress)
  const latestBlockhash = await connection.getLatestBlockhash('confirmed')

  const transaction = new Transaction({
    feePayer: publicKey,
    recentBlockhash: latestBlockhash.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: publicKey,
      toPubkey: destination,
      lamports: Number(lamports),
    }),
  )

  const signature = await sendTransaction(transaction, connection)

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  )

  if (confirmation.value.err) {
    throw new Error(`Solana transaction failed: ${signature}`)
  }

  return signature
}
```

Example React usage:

```tsx
import { useConnection, useWallet } from '@solana/wallet-adapter-react'

function DepositSolButton(props: {
  hyperliquidAddress: string
  amountSol: string
}) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const deposit = async () => {
    if (!publicKey) throw new Error('Connect a Solana wallet')

    const addressResponse = await fetch('/api/funding/solana/address', {
      credentials: 'include',
    })
    const addressBody = await addressResponse.json()
    if (!addressResponse.ok) throw new Error(addressBody.error)

    const signature = await sendSolToUnit({
      connection,
      publicKey,
      sendTransaction,
      unitDepositAddress: addressBody.address,
      amountSol: props.amountSol,
    })

    const registerResponse = await fetch('/api/funding/solana/deposits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ signature }),
    })

    const registerBody = await registerResponse.json()
    if (!registerResponse.ok) throw new Error(registerBody.error)
  }

  return <button onClick={deposit}>Deposit SOL</button>
}
```

## Verify the Solana transfer on the backend

Never trust the amount, sender, or Unit address reported by the frontend. Load the confirmed transaction from Solana and compare its transfer instruction with server-owned expectations.

```ts
import {
  Connection,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js'

export async function verifyNativeSolTransfer(params: {
  connection: Connection
  signature: string
  expectedSender: string
  expectedRecipient: string
  minimumLamports: bigint
}): Promise<{ lamports: bigint }> {
  const transaction = await params.connection.getParsedTransaction(
    params.signature,
    {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    },
  )

  if (!transaction) throw new Error('Solana transaction not found')
  if (transaction.meta?.err) throw new Error('Solana transaction failed')

  for (const instruction of transaction.transaction.message.instructions) {
    if (!('parsed' in instruction)) continue
    if (!instruction.programId.equals(SystemProgram.programId)) continue
    if (instruction.parsed?.type !== 'transfer') continue

    const info = instruction.parsed.info
    const source = new PublicKey(info.source).toBase58()
    const destination = new PublicKey(info.destination).toBase58()
    const lamports = BigInt(info.lamports)

    if (
      source === params.expectedSender &&
      destination === params.expectedRecipient &&
      lamports >= params.minimumLamports
    ) {
      return { lamports }
    }
  }

  throw new Error('Expected SOL transfer was not found')
}
```

The authenticated backend must already know:

- The user's connected Solana address.
- The user's managed Hyperliquid EVM address.
- The Unit address generated for that Hyperliquid address.
- The expected minimum or quoted amount.

## Express endpoints for SOL

The `requireUser` and database functions are application-specific, but the security boundary is explicit below.

```ts
import express from 'express'
import { Connection } from '@solana/web3.js'
import { z } from 'zod'

const router = express.Router()
const solana = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed')

router.get('/api/funding/solana/address', requireUser, async (req, res) => {
  try {
    const user = await loadUserFundingProfile(req.user.id)
    const address = await getUnitSolDepositAddress(
      user.hyperliquidAddress,
    )

    await saveUnitAddress({
      userId: req.user.id,
      hyperliquidAddress: user.hyperliquidAddress,
      unitAddress: address,
    })

    res.json({ address })
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
})

const registerSolSchema = z.object({
  signature: z.string().min(40).max(128),
})

router.post(
  '/api/funding/solana/deposits',
  requireUser,
  async (req, res) => {
    try {
      const { signature } = registerSolSchema.parse(req.body)
      const profile = await loadUserFundingProfile(req.user.id)
      const unit = await loadSavedUnitAddress(req.user.id)

      const verified = await verifyNativeSolTransfer({
        connection: solana,
        signature,
        expectedSender: profile.solanaAddress,
        expectedRecipient: unit.unitAddress,
        minimumLamports: 1n,
      })

      const deposit = await insertFundingDeposit({
        userId: req.user.id,
        provider: 'unit',
        routeId: signature,
        sourceChain: 'solana',
        sourceAsset: 'SOL',
        sourceAmount: verified.lamports.toString(),
        sourceWallet: profile.solanaAddress,
        destinationAddress: profile.hyperliquidAddress,
        sourceTxHash: signature,
        status: 'source_confirmed',
      })

      res.status(201).json({ deposit })
    } catch (error) {
      res.status(400).json({ error: (error as Error).message })
    }
  },
)
```

---

# Route 2: native USDC on Arbitrum

## Constants

```ts
export const ARBITRUM_CHAIN_ID = 42161
export const ARBITRUM_CHAIN_ID_HEX = '0xa4b1'

// Native Circle USDC on Arbitrum, not USDC.e.
export const ARBITRUM_USDC =
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

export const HYPERLIQUID_ARBITRUM_BRIDGE =
  '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'
```

## Destination semantics

The canonical bridge deposit is a USDC transfer into the bridge. Hyperliquid credits the EVM address that made the deposit.

This matters if an application uses a managed Hyperliquid wallet:

- If the user deposits from `0xExternal`, Hyperliquid credits `0xExternal`.
- Merely storing or displaying a different `0xManaged` destination does not redirect the deposit.

For a managed account, either require the source address to equal the managed Hyperliquid address, fund the managed address first and deposit from it, or use a provider that supports an explicit destination address.

## Recommended browser-paid deposit

The simplest and safest flow is for the connected wallet to call USDC `transfer` directly. It avoids maintaining a server gas-payer and avoids a two-transaction `permit` plus `transferFrom` sequence.

```ts
import { ethers } from 'ethers'

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

export async function depositArbitrumUsdc(
  amountUsdc: string,
): Promise<string> {
  if (!window.ethereum) throw new Error('Connect an EVM wallet')

  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: ARBITRUM_CHAIN_ID_HEX }],
  })

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()
  const sender = await signer.getAddress()
  const network = await provider.getNetwork()

  if (Number(network.chainId) !== ARBITRUM_CHAIN_ID) {
    throw new Error('Wallet is not connected to Arbitrum')
  }

  const usdc = new ethers.Contract(ARBITRUM_USDC, USDC_ABI, signer)
  const decimals = Number(await usdc.decimals())
  const amount = ethers.parseUnits(amountUsdc, decimals)
  const balance = await usdc.balanceOf(sender)

  if (balance < amount) throw new Error('Insufficient Arbitrum USDC')

  const transaction = await usdc.transfer(
    HYPERLIQUID_ARBITRUM_BRIDGE,
    amount,
  )
  const receipt = await transaction.wait()

  if (!receipt || receipt.status !== 1) {
    throw new Error('Arbitrum bridge transfer failed')
  }

  return transaction.hash
}
```

The connected EVM address must be the intended Hyperliquid account for this direct route.

## Optional gas-sponsored EIP-2612 flow

Use this only when a backend account should pay the Arbitrum gas. The user signs an EIP-2612 permit; the backend submits `permit` and then `transferFrom`.

### Backend permit generator

```ts
import { ethers } from 'ethers'

const PERMIT_READ_ABI = [
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
]

export async function createUsdcPermit(params: {
  owner: string
  spender: string
  amountUsdc: string
}) {
  const provider = new ethers.JsonRpcProvider(
    process.env.ARBITRUM_RPC_URL,
  )
  const usdc = new ethers.Contract(
    ARBITRUM_USDC,
    PERMIT_READ_ABI,
    provider,
  )

  const [nonce, name, version, decimals] = await Promise.all([
    usdc.nonces(params.owner),
    usdc.name(),
    usdc.version(),
    usdc.decimals(),
  ])

  const deadline = Math.floor(Date.now() / 1000) + 3600
  const value = ethers.parseUnits(params.amountUsdc, decimals)

  return {
    domain: {
      name,
      version,
      chainId: ARBITRUM_CHAIN_ID,
      verifyingContract: ARBITRUM_USDC,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    message: {
      owner: params.owner,
      spender: params.spender,
      value: value.toString(),
      nonce: nonce.toString(),
      deadline,
    },
  }
}
```

### Browser signature

```ts
const provider = new ethers.BrowserProvider(window.ethereum)
const signer = await provider.getSigner()
const owner = await signer.getAddress()

const permitResponse = await fetch('/api/funding/arbitrum/permit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ owner, amountUsdc }),
})
const permit = await permitResponse.json()

const signature = await signer.signTypedData(
  permit.domain,
  permit.types,
  permit.message,
)
const { v, r, s } = ethers.Signature.from(signature)

const depositResponse = await fetch('/api/funding/arbitrum/deposits', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    owner,
    amountUsdc,
    permit: { v, r, s, deadline: permit.message.deadline },
  }),
})
```

### Backend execution

```ts
const USDC_WRITE_ABI = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

export async function executeSponsoredArbitrumDeposit(params: {
  owner: string
  amountUsdc: string
  permit: {
    v: number
    r: string
    s: string
    deadline: number
  }
}) {
  if (params.permit.deadline <= Math.floor(Date.now() / 1000)) {
    throw new Error('Permit expired')
  }

  const provider = new ethers.JsonRpcProvider(
    process.env.ARBITRUM_RPC_URL,
  )
  const gasPayer = new ethers.Wallet(
    process.env.ARBITRUM_GAS_PAYER_PRIVATE_KEY!,
    provider,
  )
  const usdc = new ethers.Contract(
    ARBITRUM_USDC,
    USDC_WRITE_ABI,
    gasPayer,
  )

  const decimals = await usdc.decimals()
  const amount = ethers.parseUnits(params.amountUsdc, decimals)
  const allowance = await usdc.allowance(params.owner, gasPayer.address)
  let permitTxHash: string | undefined

  if (allowance < amount) {
    const permitTx = await usdc.permit(
      params.owner,
      gasPayer.address,
      amount,
      params.permit.deadline,
      params.permit.v,
      params.permit.r,
      params.permit.s,
    )
    const permitReceipt = await permitTx.wait()
    if (!permitReceipt || permitReceipt.status !== 1) {
      throw new Error('Permit transaction failed')
    }
    permitTxHash = permitTx.hash
  }

  const transferTx = await usdc.transferFrom(
    params.owner,
    HYPERLIQUID_ARBITRUM_BRIDGE,
    amount,
  )
  const transferReceipt = await transferTx.wait()

  if (!transferReceipt || transferReceipt.status !== 1) {
    throw new Error('Bridge transfer failed')
  }

  return {
    permitTxHash,
    transferTxHash: transferTx.hash,
    creditedHyperliquidAddress: params.owner,
  }
}
```

The backend must reconstruct and validate the expected owner, spender, amount, chain, token, nonce, and deadline. Do not execute permit data merely because the browser supplied it.

---

# Route 3: native ETH on Ethereum

There is no provider-independent direct transaction for ETH -> Hyperliquid. A route provider must quote a swap/bridge operation and return an Ethereum transaction for the user to sign.

The integration should isolate vendor-specific behavior behind this interface:

```ts
export interface EthToHyperliquidProvider {
  createQuote(input: {
    amountWei: string
    sourceWallet: string
    hyperliquidDestination: string
    slippageBps: number
  }): Promise<{
    routeId: string
    expiresAt: string
    estimatedOutputUsdc: string
    transaction: {
      chainId: 1
      to: string
      data: string
      value: string
      gasLimit?: string
    }
  }>

  getStatus(routeId: string): Promise<{
    status: FundingStatus
    sourceTxHash?: string
    destinationTxHash?: string
    settledOutputUsdc?: string
    error?: string
  }>
}
```

## Backend quote endpoint

The backend derives the Hyperliquid destination from the authenticated user:

```ts
const ethQuoteSchema = z.object({
  amountWei: z.string().regex(/^\d+$/),
  sourceWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  slippageBps: z.number().int().min(1).max(500),
})

router.post(
  '/api/funding/ethereum/quote',
  requireUser,
  async (req, res) => {
    try {
      const input = ethQuoteSchema.parse(req.body)
      const profile = await loadUserFundingProfile(req.user.id)

      const quote = await ethProvider.createQuote({
        ...input,
        hyperliquidDestination: profile.hyperliquidAddress,
      })

      if (quote.transaction.chainId !== 1) {
        throw new Error('Provider returned the wrong source chain')
      }

      if (!ALLOWED_ETH_ROUTE_CONTRACTS.has(
        quote.transaction.to.toLowerCase(),
      )) {
        throw new Error('Provider returned an unapproved contract')
      }

      await insertFundingDeposit({
        userId: req.user.id,
        provider: 'cross-chain-provider',
        routeId: quote.routeId,
        sourceChain: 'ethereum',
        sourceAsset: 'ETH',
        sourceAmount: input.amountWei,
        sourceWallet: input.sourceWallet,
        destinationAddress: profile.hyperliquidAddress,
        status: 'quoted',
      })

      res.json(quote)
    } catch (error) {
      res.status(400).json({ error: (error as Error).message })
    }
  },
)
```

`ALLOWED_ETH_ROUTE_CONTRACTS` should come from the provider's official deployment list, not from browser input.

## Browser execution

```ts
import { ethers } from 'ethers'

type EvmRouteTransaction = {
  chainId: number
  to: string
  data: string
  value: string
  gasLimit?: string
}

export async function executeEthereumRoute(
  route: EvmRouteTransaction,
): Promise<string> {
  if (!window.ethereum) throw new Error('Connect an EVM wallet')
  if (route.chainId !== 1) throw new Error('Expected Ethereum mainnet')

  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x1' }],
  })

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  const transaction = await signer.sendTransaction({
    to: route.to,
    data: route.data,
    value: BigInt(route.value),
    gasLimit: route.gasLimit ? BigInt(route.gasLimit) : undefined,
  })

  return transaction.hash
}
```

After submission, register only the route ID and transaction hash:

```ts
await fetch('/api/funding/ethereum/deposits', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ routeId, sourceTxHash }),
})
```

The backend must reload the stored quote by `routeId`. It must not accept a replacement destination, amount, contract, calldata, or transaction value from the browser.

## Provider adapter template

Replace the paths and response fields with the selected provider's documented API. This code intentionally does not invent a trade.xyz endpoint.

```ts
export class HttpEthFundingProvider
  implements EthToHyperliquidProvider
{
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async createQuote(input: {
    amountWei: string
    sourceWallet: string
    hyperliquidDestination: string
    slippageBps: number
  }) {
    const response = await fetch(`${this.baseUrl}/REPLACE_WITH_QUOTE_PATH`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })

    const body = await response.json()
    if (!response.ok) {
      throw new Error(body.error || 'Unable to create funding quote')
    }

    return body
  }

  async getStatus(routeId: string) {
    const response = await fetch(
      `${this.baseUrl}/REPLACE_WITH_STATUS_PATH/${encodeURIComponent(routeId)}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    )

    const body = await response.json()
    if (!response.ok) {
      throw new Error(body.error || 'Unable to load route status')
    }

    return body
  }
}
```

An ETH route is not production-ready until the placeholders above are mapped to a real provider's authenticated quote and status APIs.

---

# Database schema

Use one provider-neutral table for every funding route:

```sql
CREATE TABLE cross_chain_deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  route_id TEXT NOT NULL,
  source_chain TEXT NOT NULL,
  source_asset TEXT NOT NULL,
  source_amount NUMERIC(78, 0) NOT NULL,
  source_wallet TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  source_tx_hash TEXT,
  destination_tx_hash TEXT,
  status TEXT NOT NULL,
  quoted_output_amount NUMERIC,
  settled_output_amount NUMERIC,
  error_message TEXT,
  raw_provider_status JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, route_id),
  UNIQUE (source_chain, source_tx_hash)
);

CREATE INDEX cross_chain_deposits_pending_idx
ON cross_chain_deposits (status, updated_at)
WHERE status NOT IN ('completed', 'failed', 'refunded');
```

Store `source_amount` in the source asset's smallest unit:

- SOL: lamports.
- ETH: wei.
- USDC: units using the token's decimals, normally six for native Arbitrum USDC.

---

# Reconciliation worker

Do not rely on an HTTP request, browser polling, or an in-process `setTimeout` to finish a deposit. Run a durable worker repeatedly:

```ts
export async function reconcileFundingDeposits() {
  const deposits = await loadNonterminalDeposits({ limit: 100 })

  for (const deposit of deposits) {
    try {
      if (deposit.provider === 'unit') {
        await reconcileUnitDeposit(deposit)
        continue
      }

      if (deposit.provider === 'hyperliquid-bridge') {
        await reconcileArbitrumDeposit(deposit)
        continue
      }

      if (deposit.provider === 'cross-chain-provider') {
        const status = await ethProvider.getStatus(deposit.routeId)
        await updateDepositFromProviderStatus(deposit.id, status)
      }
    } catch (error) {
      await recordReconciliationError(
        deposit.id,
        (error as Error).message,
      )
    }
  }
}
```

Make every reconciliation step idempotent. Before submitting a conversion or account transfer, query Hyperliquid and the database to determine whether it already happened.

---

# Optional SOL -> USDC and spot -> perps

Unit deposits SOL into Hyperliquid spot. If the product needs perps collateral, it must:

1. Wait until the SOL spot balance is available.
2. Place a SOL/USDC spot sell through a Hyperliquid SDK/API client signed by the Hyperliquid account.
3. Read the actual fill amount rather than using the quote estimate.
4. Transfer the resulting USDC from spot to perps.

Keep these actions behind a small application interface because exact signing and asset-index APIs depend on the Hyperliquid client library version:

```ts
export interface HyperliquidAccountClient {
  getSpotBalance(asset: 'SOL' | 'USDC'): Promise<string>

  sellSolForUsdc(input: {
    amountSol: string
    maximumSlippageBps: number
  }): Promise<{
    orderId: string
    filledSol: string
    receivedUsdc: string
  }>

  transferUsdcSpotToPerps(amountUsdc: string): Promise<{
    transactionId: string
  }>
}

export async function convertSolDepositToPerps(
  client: HyperliquidAccountClient,
  amountSol: string,
) {
  const balance = await client.getSpotBalance('SOL')
  if (BigInt(balance) < BigInt(amountSol)) {
    throw new Error('SOL has not arrived in Hyperliquid spot')
  }

  const fill = await client.sellSolForUsdc({
    amountSol,
    maximumSlippageBps: 100,
  })

  const transfer = await client.transferUsdcSpotToPerps(
    fill.receivedUsdc,
  )

  return { fill, transfer }
}
```

Do not copy hard-coded asset indices or signing formats from an older client. Resolve the SOL spot market from current metadata and follow the installed SDK's signing API.

---

# Production checklist

- Derive the Hyperliquid destination from the authenticated user on the backend.
- Verify ownership of connected Solana and EVM addresses before funding.
- Verify every source transaction server-side.
- Validate source chain, asset contract/mint, sender, recipient, amount, success, and finality.
- Use smallest-unit integer strings for all stored and transmitted settlement amounts.
- Enforce minimum deposits from the current bridge/provider configuration.
- Treat quote expiry as authoritative.
- Allow-list provider contracts and source chain IDs.
- Make route IDs and source transaction hashes unique.
- Separate source confirmation, bridge completion, Hyperliquid arrival, conversion, and perps transfer statuses.
- Run reconciliation in a durable queue or scheduled worker.
- Save each source, permit, bridge, destination, conversion, and transfer transaction identifier.
- Use actual fills and settled outputs, not estimates.
- Handle partial fills and refunds explicitly.
- Never log private keys, signed serialized transactions, permit signatures, or API keys.
- Rate-limit quote, address-generation, registration, and status endpoints.
- Test with small values before enabling unrestricted amounts.

## What can be integrated immediately

- **SOL route:** the Unit address-generation, Solana transfer, transaction verification, persistence, and reconciliation structure above are directly usable.
- **Arbitrum route:** the direct USDC transfer is directly usable when the connected EVM address is the intended Hyperliquid account. The optional permit flow is usable for gas sponsorship with stricter backend validation.
- **Ethereum ETH route:** the surrounding API, signing, persistence, allow-listing, and tracking structure is usable, but a real provider adapter must replace the documented placeholders. There is no safe universal ETH -> Hyperliquid transaction that can be supplied without the selected provider's current API and contract details.
