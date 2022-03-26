import {ethers} from 'ethers';
import {ApiPromise, WsProvider, Keyring} from '@polkadot/api';
import {u8aConcat, hexFixLength} from '@polkadot/util';
import 'dotenv/config';
import {contracts} from "./compile.js";

const {log} = console;

const tokens = {
    DEV: {
        id: {
            moonbase: '0x0000000000000000000000000000000000000802',
            basilisk: 1
        },
    },
    DAI: {
        id: {
            moonbase: '0x4C153BFaD26628BdbaFECBCD160A0790b1b8F212',
            basilisk: 2
        },
    },
    VEN: {
        id: {
            moonbase: '0xCdF746C5C86Df2c2772d2D36E227B4c0203CbA25',
            basilisk: 2
        },
    },
};
const chains = {
    moonbeam: {
        name: 'moonbase-alpha', ethRpc: 'https://rpc.api.moonbase.moonbeam.network', chainId: 0x507,
        rpc: 'wss://moonbeam-alpha.api.onfinality.io/public-ws'
    }, basilisk: {
        rpc: 'wss://rpc-01.basilisk-moonbase.hydradx.io',
    }
};

async function connect() {
    console.warn = () => null;
    let balance = {};
    await Promise.all([
        async function () {
            const api = await ApiPromise.create({provider: new WsProvider(chains.moonbeam.rpc)});
            chains.moonbeam = {...chains.moonbeam, api};
            log('connected to', chains.moonbeam.rpc);
        }(),
        async function () {
            const api = await ApiPromise.create({provider: new WsProvider(chains.basilisk.rpc)});
            const keyring = new Keyring({type: 'sr25519'});
            const account = keyring.addFromUri(process.env.PHRASE);
            chains.basilisk = {...chains.basilisk, api, account, keyring};
            balance.basilisk = {
                account: account.address,
                DEV: Number(await freeTokenBalance(account.address, tokens.DEV))
            };
            log('connected to', chains.basilisk.rpc);
        }(),
        async function () {
            const provider = new ethers.providers.StaticJsonRpcProvider(chains.moonbeam.ethRpc, chains.moonbeam);
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const {Xtokens: {abi}} = contracts('Xtokens.sol');
            const Xtokens = new ethers.Contract('0x0000000000000000000000000000000000000804', abi, wallet);
            const {address} = wallet;
            chains.moonbeam = {...chains.moonbeam, provider, wallet, Xtokens, abi};
            balance.moonbeam = {address, DEV: Number(await provider.getBalance(address))};
            log('connected to', chains.moonbeam.ethRpc);
        }()]);
    console.table(balance);
}

async function freeTokenBalance(address, token) {
    const {free} = await chains.basilisk.api.query.tokens.accounts(address, token.id.basilisk);
    return free;
}

const onceBalanceChange = async (address, token) => new Promise(async resolve => {
    let initial = null;
    let cleanup = await chains.basilisk.api.query.tokens.accounts(address, token.id.basilisk, ({free}) => {
        if (initial === null) {
            initial = free;
        } else if (!initial.sub(free).isZero()) {
            resolve(free);
            cleanup();
        }
    });
});

const eventFilter = name => ({event: {section, method}}) => name === `${section}.${method}`

const onEvent = (name, chain, callback) => chain.api.query.system.events(events =>
    events.filter(eventFilter(name))
        .forEach(event => callback(event, events.filter(e => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.eq(event.phase.asApplyExtrinsic)))));

const onceEvent = (name, chain = chains.basilisk, predicate = () => true) =>
    new Promise(async resolve => {
        let cleanup = await onEvent(name, chain, (data, siblings) => {
            if (predicate(data.event.data)) {
                resolve({event: data, siblings});
                cleanup();
            }
        })
    });

const encodeDestination = ({parachain, address}, registry = chains.basilisk.api.registry) => ({
    parents: 1,
    interior: [
        hexFixLength(registry.createType('ParaId', parachain).toHex(), 40, true),
        u8aConcat(
            registry.createType('u8', 1).toU8a(),
            registry.createType('AccountId', address).toU8a(),
            registry.createType('u8', 0).toU8a())
    ]
});

async function transferFromMoonbeam({token, amount, to}) {
    const tx = await chains.moonbeam.Xtokens.transfer(token.id.moonbase, amount, encodeDestination(to), '0xee6b2800', {gasLimit: '100000'});
    log('tx sent', tx.hash);
    const execution = await onceEvent('ethereum.Executed', chains.moonbeam, ([, , hash]) => hash.toHex() === tx.hash);
    const xcmpMessage = execution.siblings.find(eventFilter('xcmpQueue.XcmpMessageSent'))?.event.data[0].toHex();
    if (!xcmpMessage) {
        log('no xcmp message sent');
        throw execution.event.event.toHuman();
    }
    log('xcmp sent', xcmpMessage);
    const {siblings} = await onceEvent('xcmpQueue.Success', chains.basilisk, ([message]) => xcmpMessage === message.toHex());
    log('xcmp received', xcmpMessage);
    return siblings;
}

async function main() {
    const {address} = chains.basilisk.account;
    const transfer = {
        token: tokens.DEV,
        amount: '10000000000000000',
        to: {
            parachain: 2090,
            address
        }
    }
    await Promise.all([
        transferFromMoonbeam(transfer).then(events => log('deposited', events.find(eventFilter('currencies.Deposited')).event.data[2].toString())),
        onceBalanceChange(transfer.to.address, transfer.token).then(free => log('new balance', free.toString()))
    ]);
}

connect()
    .then(main)
    .then(process.exit)
    .catch(e => {
        log(e);
        process.exit(1);
    });



