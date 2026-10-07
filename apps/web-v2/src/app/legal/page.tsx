import Link from "next/link";

export const metadata = {
  title: "Legal | Ready Set Trade",
  description: "Terms of Service and Privacy Policy for Ready Set Trade.",
};

const p = "text-sm leading-6 text-muted-foreground";
const ul = "list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground";

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h3 className="text-base font-semibold">{n}. {title}</h3>{children}</section>;
}

export default function LegalPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-4xl px-6 py-12">
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">&larr; Ready Set Trade</Link>
        <h1 className="mb-10 mt-8 text-2xl font-bold">Legal</h1>

        <article aria-labelledby="terms-heading" className="space-y-8">
          <header className="space-y-3 border-b pb-6">
            <h2 id="terms-heading" className="text-xl font-semibold">Terms of Service</h2>
            <p className={p}>Version 2.0</p>
            <p className={p}>Last updated and effective: September 9, 2026</p>
            <p className={p}>These Terms of Service (the &quot;Terms&quot;) are a binding agreement between you and RST Tech LLC, the company that operates Ready Set Trade (&quot;RST Tech LLC,&quot; &quot;Ready Set Trade,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;). They govern your access to and use of Ready Set Trade websites, applications, software, APIs, automated trading tools, content, and related services (collectively, the &quot;Services&quot;). The Privacy Policy below is incorporated by reference.</p>
            <p className="text-sm font-semibold leading-6">These Terms contain a binding arbitration agreement, class-action waiver, and jury-trial waiver in Section 16. Please read that section carefully.</p>
          </header>

          <Section n={1} title="Acceptance and Electronic Agreement">
            <p className={p}>By checking an acceptance box, selecting Continue, creating or using an account, or otherwise accessing the Services, you confirm that you have read and agree to these Terms and the Privacy Policy. Your electronic acceptance has the same force as a handwritten signature.</p>
            <p className={p}>If you do not agree, do not use the Services except to close or withdraw from existing positions where that functionality remains available. Contact an official Ready Set Trade support channel if you need assistance.</p>
          </Section>

          <Section n={2} title="Eligibility and Legal Compliance">
            <p className={p}>You represent that you are at least 18, can enter a binding agreement, may lawfully use the Services in every applicable jurisdiction, are not subject to applicable sanctions or restrictions, control every account or wallet you connect, and provide accurate information. You are responsible for determining whether your use of Ready Set Trade and third-party services is lawful. You must not evade geographic, sanctions, identity, or eligibility restrictions.</p>
          </Section>

          <Section n={3} title="The Services and Third Parties">
            <p className={p}>Ready Set Trade provides software for researching and monitoring markets, connecting brokerage or trading accounts, managing positions, placing trades, following or copying activity, and automating user-selected instructions. RST Tech LLC is not a broker, exchange, market maker, clearinghouse, custodian, investment adviser, fiduciary, or counterparty to your trades.</p>
            <p className={p}>The Services interact with independent brokerages, exchanges, trading venues, blockchains, smart contracts, wallets, authentication providers, APIs, data sources, and infrastructure providers. Their services have separate terms and may change, fail, restrict access, or cease operating. RST Tech LLC does not control them and is not responsible for their acts, omissions, data practices, availability, security, pricing, settlement, or results.</p>
          </Section>

          <Section n={4} title="Accounts, Credentials, and User Authorization">
            <p className={p}>You authorize RST Tech LLC and its service providers to prepare, submit, relay, modify, or cancel orders and transactions as reasonably necessary to perform instructions you submit or configure, including automated, copy, and mirror instructions. You remain responsible for:</p>
            <ul className={ul}>
              <li>Protecting devices, credentials, API keys, private keys, seed phrases, PINs, and recovery methods.</li>
              <li>Reviewing accounts, permissions, settings, limits, addresses, orders, and transaction details.</li>
              <li>Maintaining sufficient balances, buying power, collateral, margin, gas, and approvals.</li>
              <li>Revoking access and withdrawing assets when you stop using an account, wallet, or the Services.</li>
              <li>Activity through your account or connected accounts, including activity caused by compromised credentials.</li>
            </ul>
            <p className={p}>Trades and blockchain transactions may be irreversible. RST Tech LLC cannot reverse, recover, or guarantee recovery of lost, stolen, liquidated, misdirected, or inaccessible funds or digital assets.</p>
          </Section>

          <Section n={5} title="No Financial, Legal, or Tax Advice">
            <p className={p}>Information, rankings, analytics, simulations, backtests, opinions, alerts, educational material, artificial-intelligence output, and configuration suggestions are for general information only. They are not financial, investment, trading, legal, accounting, or tax advice or a recommendation or solicitation. RST Tech LLC is not your adviser or fiduciary. You make every trading and configuration decision at your own discretion and risk.</p>
          </Section>

          <Section n={6} title="Trading and Technology Risks">
            <p className="text-sm font-semibold">Trading is risky. You may lose 100% of the funds or assets you commit.</p>
            <p className={p}>Trading, copy trading, mirror trading, automation, leverage, options, perpetual futures, digital assets, and smart contracts involve substantial risk, including:</p>
            <ul className={ul}>
              <li>Volatility, illiquidity, slippage, price movement, and insufficient order-book depth.</li>
              <li>Delayed, skipped, duplicated, partial, rejected, failed, or differently priced executions.</li>
              <li>A followed trader changing, canceling, or closing activity before or after a copied trade.</li>
              <li>Incorrect, incomplete, stale, delayed, manipulated, or unavailable third-party data.</li>
              <li>Brokerage, exchange, blockchain, smart-contract, oracle, wallet, API, and network failures.</li>
              <li>Software bugs, outages, congestion, latency, cyberattacks, unauthorized access, and lost credentials.</li>
              <li>Liquidation, assignment, exercise, funding, collateral, margin, settlement, regulatory, tax, and counterparty risks.</li>
              <li>Permanent loss caused by an incorrect symbol, contract, side, quantity, price, address, network, setting, approval, or instruction.</li>
            </ul>
            <p className={p}>Past or simulated performance, rankings, and backtests do not guarantee future results. Automation may amplify losses and may continue until you disable it and the Services successfully process that change. Stops, limits, risk controls, alerts, and similar features may fail, trigger late, or execute at an unexpected price.</p>
          </Section>

          <Section n={7} title="No Continued-Feature or Result Guarantees">
            <p className={p}>RST Tech LLC does not guarantee any trading result, fill, price, uptime level, data source, supported asset, integration, reward, referral benefit, promotion, or continued feature availability. Supported markets, integrations, access rules, pricing, and functionality may change, be restricted, or end at any time.</p>
          </Section>

          <Section n={8} title="Fees and Taxes">
            <p className={p}>You are responsible for all fees, commissions, spreads, funding charges, subscriptions, network costs, gas, taxes, and third-party charges associated with your activity. Fees already incurred are non-refundable except where required by law. You are solely responsible for determining, reporting, and paying applicable taxes.</p>
          </Section>

          <Section n={9} title="Account Security">
            <p className={p}>You must reasonably secure your account and promptly notify an official support channel of suspected unauthorized access. RST Tech LLC is not responsible for losses caused by your failure to secure an account, device, wallet, key, credential, API key, session, or third-party account, except to the extent applicable law does not allow that responsibility to be disclaimed.</p>
          </Section>

          <Section n={10} title="Prohibited Use">
            <p className={p}>You must not use the Services for unlawful, fraudulent, abusive, manipulative, or deceptive conduct; evade sanctions or access restrictions; disrupt, probe, exploit, or access systems without authorization; introduce malware; overload undocumented interfaces; infringe others&apos; rights; misrepresent your identity, eligibility, authority, location, or source of funds; or reverse engineer, copy, resell, sublicense, or create derivative works except where applicable law expressly permits.</p>
          </Section>

          <Section n={11} title="Intellectual Property and Feedback">
            <p className={p}>The Services, excluding third-party materials and user content, belong to RST Tech LLC or its licensors. Subject to these Terms, you receive a limited, revocable, non-exclusive, non-transferable license to use them as intended. You grant RST Tech LLC a perpetual, irrevocable, worldwide, royalty-free license to use and commercialize feedback you submit without restriction or compensation.</p>
          </Section>

          <Section n={12} title="Suspension, Restriction, and Termination">
            <p className={p}>RST Tech LLC may, in its sole discretion and without prior notice, suspend, restrict, disable, or terminate access; pause trading; cancel pending instructions where technically possible; impose limits; remove content; or discontinue features. Reasons may include suspected legal or policy violations, security risk, fraud, abuse, sanctions exposure, third-party requirements, operational risk, nonpayment, or protection of RST Tech LLC, users, or the public.</p>
            <p className={p}>To the fullest extent permitted by law, we are not liable for losses arising from these actions. Where technically and legally available, you remain responsible for withdrawing assets and closing positions. We need not preserve data or account access after termination except as required by law.</p>
          </Section>

          <Section n={13} title="Disclaimer of Warranties and Security Guarantees">
            <p className="text-sm font-semibold uppercase leading-6">To the fullest extent permitted by law, the Services are provided &quot;as is&quot; and &quot;as available,&quot; with all faults and without warranties of any kind. RST Tech LLC and its owners, officers, employees, contractors, affiliates, licensors, and service providers (the &quot;RST Tech LLC Parties&quot;) disclaim all express, implied, and statutory warranties, including merchantability, fitness for a particular purpose, title, non-infringement, accuracy, quiet enjoyment, and warranties arising from course of dealing or usage of trade.</p>
            <p className={p}>The RST Tech LLC Parties do not guarantee the security or safety of accounts, credentials, wallets, assets, funds, data, orders, transactions, third-party services, or the Services. We do not warrant that the Services will be secure, uninterrupted, timely, accurate, complete, error-free, compatible, or free of harmful components, or that defects will be corrected or losses recovered. You assume the entire risk of using the Services and interacting with third parties.</p>
          </Section>

          <Section n={14} title="Limitation of Liability">
            <p className="text-sm font-semibold uppercase leading-6">To the fullest extent permitted by law, the RST Tech LLC Parties will not be liable for direct, indirect, incidental, special, consequential, exemplary, punitive, or other damages or losses of any kind arising out of or relating to the Services or these Terms.</p>
            <p className={p}>This exclusion includes trading losses; loss of funds, digital assets, profits, revenue, opportunities, or data; business interruption; reputational harm; unauthorized access; security incidents; third-party conduct; and substitute-service costs, regardless of the theory of liability and even if an RST Tech LLC Party was advised that loss was possible.</p>
            <p className={p}>To the fullest extent permitted by law, the RST Tech LLC Parties have no liability for losses caused by third-party services, brokerages, trading venues, blockchains, smart contracts, account compromise, user instructions, automation settings, bugs, outages, latency, inaccurate data, or delayed, failed, partial, duplicate, or differently priced execution.</p>
            <p className={p}>Where a jurisdiction does not allow an exclusion, it applies only to the maximum extent permitted, and non-waivable liability is limited to the minimum remedy required by law. Nothing excludes liability that cannot legally be excluded.</p>
          </Section>

          <Section n={15} title="Indemnification">
            <p className={p}>To the fullest extent permitted by law, you will defend, indemnify, and hold harmless the RST Tech LLC Parties from claims, liabilities, damages, judgments, losses, costs, and reasonable legal fees arising from your use, transactions, violation of these Terms or law, infringement of another person&apos;s rights, or activity through your account, connected accounts, or wallets. This does not apply where indemnification cannot lawfully be required.</p>
          </Section>

          <Section n={16} title="Binding Arbitration, Class-Action Waiver, and Jury-Trial Waiver">
            <p className={p}>Before a formal proceeding, you and RST Tech LLC agree to make a good-faith effort for 30 days to resolve the dispute through an official Ready Set Trade support channel. Notice must describe the dispute and requested relief.</p>
            <p className={p}>Except for an individual small-claims matter and temporary or injunctive relief concerning unauthorized access, security, or intellectual property, either party may elect final and binding individual arbitration for any dispute arising from the Services, these Terms, or the relationship between you and RST Tech LLC. Arbitration will be administered by the American Arbitration Association (&quot;AAA&quot;) under its applicable Consumer Arbitration Rules and governed by the Federal Arbitration Act. An arbitrator may award individual relief available in court, subject to these Terms, but may not combine claims or preside over a representative or class proceeding.</p>
            <p className="text-sm font-semibold uppercase leading-6">You and RST Tech LLC waive the right to a jury trial and to participate in a class, collective, consolidated, or representative action or arbitration. Claims may be brought only individually.</p>
            <p className={p}>If the class or representative relief prohibition is unenforceable for a claim or remedy, that portion will be decided by a court and remaining claims arbitrated. Other unenforceable provisions will be severed.</p>
            <p className={p}>You may opt out of arbitration by sending written notice through an official Ready Set Trade support channel within 30 days after first accepting Version 2.0. Identify your account and state that you opt out. Opting out does not affect the remaining Terms.</p>
          </Section>

          <Section n={17} title="Changes to the Services and These Terms">
            <p className={p}>RST Tech LLC may revise these Terms or the Privacy Policy. Unless law requires otherwise, changes may be effective when posted. We may require acceptance before further use. Changes to Section 16 do not apply to a dispute of which both parties had actual notice before the changes were posted.</p>
          </Section>

          <Section n={18} title="General Terms">
            <p className={p}>RST Tech LLC may assign these Terms, including with a merger, financing, reorganization, acquisition, or asset sale. You may not assign them without written consent. Invalid provisions will be limited or severed to the minimum necessary. The remainder stays effective; failure to enforce is not waiver; headings are for convenience; and these Terms and the Privacy Policy are the entire agreement concerning the Services.</p>
          </Section>

          <Section n={19} title="Contact">
            <p className={p}>Questions, legal notices, arbitration opt-outs, and privacy requests may be submitted through official Ready Set Trade support channels identified in the Services, including our <a href="https://discord.gg/sol-decoder" target="_blank" rel="noreferrer" className="underline hover:text-foreground">Discord community</a>.</p>
          </Section>
        </article>

        <article aria-labelledby="privacy-heading" className="mt-16 space-y-5 border-t pt-12">
          <h2 id="privacy-heading" className="text-xl font-semibold">Privacy Policy</h2>
          <p className={p}>Last updated: September 9, 2026</p>
          <p className={p}>This Privacy Policy describes how RST Tech LLC, the company that operates Ready Set Trade, handles information in connection with the Services.</p>
          <p className={p}>We collect information you provide when you create an account, connect a brokerage or trading account, or contact support, including your email address, authentication credentials, and brokerage API keys stored encrypted at rest. We also collect usage data such as trade history, order activity, and feature interactions to operate and improve the Services.</p>
          <p className={p}>We use information to provide, maintain, and improve the Services; process trades and synchronize positions; send transactional communications; and detect and prevent unauthorized activity. We do not sell personal information.</p>
          <p className={p}>We share information only as needed to operate the Services, including with connected providers such as Alpaca and Hyperliquid; authentication, database, hosting, and infrastructure providers; and as required by valid legal process. Brokerage API keys are transmitted over TLS and stored using industry-standard encryption.</p>
          <p className={p}>You may request deletion of your account and associated personal data through our <a href="https://discord.gg/sol-decoder" target="_blank" rel="noreferrer" className="underline hover:text-foreground">Discord community</a>. Some data may be retained for legal compliance, dispute resolution, or fraud prevention.</p>
        </article>
      </main>
    </div>
  );
}
