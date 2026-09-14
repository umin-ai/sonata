// SPDX-License-Identifier: GPL-3.0-or-later
// Creates a separate, disposable Devnet market. Never export the upgrade key.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import anchor from '@coral-xyz/anchor';
import {Connection,Keypair,Transaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MINT_SIZE,ExtensionType,getMintLen,createInitializeMint2Instruction,createInitializeScaledUiAmountConfigInstruction,createAssociatedTokenAccountIdempotentInstruction,createMintToCheckedInstruction} from '@solana/spl-token';
import {createClient,DEVNET_GENESIS} from '../sdk/client.mjs';
const connection=new Connection('https://api.devnet.solana.com','confirmed');
if(await connection.getGenesisHash()!==DEVNET_GENESIS)throw Error('Devnet required');
mkdirSync('.keys/app-demo',{recursive:true,mode:0o700});
function key(name){const path=`.keys/app-demo/${name}.json`;if(existsSync(path))return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path))));const k=Keypair.generate();writeFileSync(path,JSON.stringify([...k.secretKey]),{mode:0o600,flag:'wx'});return k;}
const admin=key('authority'),stock=key('stock'),cash=key('cash'),oracle=key('oracle');
const deployer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.keys/deployer.json'))));
const provider=new anchor.AnchorProvider(connection,new anchor.Wallet(admin),{commitment:'confirmed'});
const c=createClient(JSON.parse(readFileSync('sdk/idl/stockroom_credit.json')),JSON.parse(readFileSync('sdk/idl/demo_oracle.json')),provider,{admin:admin.publicKey,collateralMint:stock.publicKey,debtMint:cash.publicKey,oracleAccount:oracle.publicKey});
const output='artifacts/app-demo.json';
const manifest=existsSync(output)?JSON.parse(readFileSync(output)):{network:'solana:devnet',genesis:DEVNET_GENESIS,admin:admin.publicKey.toBase58(),collateralMint:stock.publicKey.toBase58(),debtMint:cash.publicKey.toBase58(),oracleAccount:oracle.publicKey.toBase58(),market:c.market.toBase58(),cashVault:c.cashVault.toBase58(),collateralVault:c.collateralVault.toBase58(),creditProgram:c.credit.programId.toBase58(),oracleProgram:c.oracle.programId.toBase58(),stockDecimals:8,cashDecimals:6,demoPrice:200,createdAt:new Date().toISOString(),steps:[]};
async function send(label,ixs,signers=[admin]){if(manifest.steps.some(s=>s.label===label))return;const latest=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:signers[0].publicKey,...latest}).add(ComputeBudgetProgram.setComputeUnitLimit({units:400000}),...await Promise.all(ixs));tx.sign(...signers);const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});for(let n=0;n<40;n++){await new Promise(r=>setTimeout(r,1500));const s=(await connection.getSignatureStatuses([signature])).value[0];if(s?.err)throw Error(JSON.stringify(s.err));if(s?.confirmationStatus==='confirmed'||s?.confirmationStatus==='finalized'){manifest.steps.push({label,signature});writeFileSync(output,JSON.stringify(manifest,null,2)+'\n');console.log(label,signature);return;}}throw Error('Confirmation pending: '+signature);}
await send('Fund disposable app authority with 0.25 Devnet SOL',[SystemProgram.transfer({fromPubkey:deployer.publicKey,toPubkey:admin.publicKey,lamports:250000000})],[deployer]);
async function mintAccount(k,space,programId){return SystemProgram.createAccount({fromPubkey:admin.publicKey,newAccountPubkey:k.publicKey,space,lamports:await connection.getMinimumBalanceForRentExemption(space),programId});}
await send('Create demo USD mint',[await mintAccount(cash,MINT_SIZE,TOKEN_PROGRAM_ID),createInitializeMint2Instruction(cash.publicKey,6,admin.publicKey,null)],[admin,cash]);
await send('Create demo stock mint',[await mintAccount(stock,getMintLen([ExtensionType.ScaledUiAmountConfig]),TOKEN_2022_PROGRAM_ID),createInitializeScaledUiAmountConfigInstruction(stock.publicKey,admin.publicKey,1,TOKEN_2022_PROGRAM_ID),createInitializeMint2Instruction(stock.publicKey,8,admin.publicKey,null,TOKEN_2022_PROGRAM_ID)],[admin,stock]);
await send('Initialize fixed demo oracle',[c.initializeOracle()],[admin,oracle]);
await send('Initialize interactive credit market',[c.initializeMarket()]);
await send('Seed 50000 demo USD of lending liquidity',[createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,c.cash(admin.publicKey).userCash,admin.publicKey,cash.publicKey),createMintToCheckedInstruction(cash.publicKey,c.cash(admin.publicKey).userCash,admin.publicKey,50000000000n,6),c.initializePosition(admin.publicKey),c.supply(admin.publicKey,50000000000n)]);
console.log(JSON.stringify({market:manifest.market,authority:manifest.admin,remainingTestSOL:await connection.getBalance(admin.publicKey)/1e9}));
