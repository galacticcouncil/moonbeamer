import {ethers} from 'ethers';
import {ApiPromise, WsProvider, Keyring} from '@polkadot/api';
import {u8aConcat, hexFixLength} from '@polkadot/util';
import 'dotenv/config';
import {contracts} from "./compile.js";

const tokens = {
    DEV: {
        id: {
            moonbase: '0x0000000000000000000000000000000000000802',
            basilisk: 1
        },
    }
};
const chains = {
    moonbeam: {
        name: 'moonbase-alpha', ethRpc: 'https://rpc.api.moonbase.moonbeam.network', chainId: 0x507,
        rpc: 'wss://moonbeam-alpha.api.onfinality.io/public-ws'
    }, basilisk: {
        rpc: 'wss://rpc-01.basilisk-moonbase.hydradx.io',
    }
};

async function init() {
    {
        const api = await ApiPromise.create({provider: new WsProvider(chains.moonbeam.rpc)});
        chains.moonbeam = {...chains.moonbeam, api};
    }
    {
        const api = await ApiPromise.create({provider: new WsProvider(chains.basilisk.rpc)});
        const keyring = new Keyring({type: 'sr25519'});
        const account = keyring.addFromUri(process.env.PHRASE);
        chains.basilisk = {...chains.basilisk, api, account, keyring};
        const balance = await freeTokenBalance(account.address, tokens.DEV);
        console.log(account.address, balance.toString());
    }
    {
        const provider = new ethers.providers.StaticJsonRpcProvider(chains.moonbeam.ethRpc, chains.moonbeam);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const {Xtokens: {abi}} = contracts('Xtokens.sol');
        const Xtokens = new ethers.Contract('0x0000000000000000000000000000000000000804', abi, wallet);
        const {address} = wallet;
        chains.moonbeam = {...chains.moonbeam, provider, wallet, Xtokens, abi};
        console.log(address, String(await provider.getBalance(address)));
    }
}

async function freeTokenBalance(address, token) {
    const balance = await chains.basilisk.api.query.tokens.accounts(address, token.id.basilisk);
    return balance.free;
}

const eventFilter = event => ({event: {section, method}}) => event === `${section}.${method}`

const onEvent = (chain, event, callback) => chain.api.query.system.events(events =>
    events.filter(eventFilter(event))
    .forEach(event => callback(event, events.filter(e => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.eq(event.phase.asApplyExtrinsic)))));

const onceEvent = (event, chain = chains.basilisk, predicate = () => true) =>
    new Promise(resolve => onEvent(chain, event, (data, siblings) => {
        if (predicate(data.event.data)) resolve({event: data, siblings})
    }));

async function transferToParachain({token, amount, to: {parachain, address}}) {
    const {api: {registry}} = chains.basilisk;
    const destination = {
        parents: 1,
        interior: [
            hexFixLength(registry.createType('ParaId', parachain).toHex(), 40, true),
            u8aConcat(
                registry.createType('u8', 1).toU8a(),
                registry.createType('AccountId', address).toU8a(),
                registry.createType('u8', 0).toU8a())
        ]
    };
    return chains.moonbeam.Xtokens.transfer(token.id.moonbase, amount, destination, '0xee6b2800');
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
    console.log('sending', transfer);
    const tx = await transferToParachain(transfer);
    console.log('tx sent', tx.hash);
    const xcmpMessage = await onceEvent('ethereum.Executed', chains.moonbeam, ([,,hash]) => hash.toHex() === tx.hash)
        .then(({siblings}) => siblings.find(eventFilter('xcmpQueue.XcmpMessageSent')).event.data[0].toHex());
    console.log('xcmp sent', xcmpMessage);
    const {event} = await onceEvent('xcmpQueue.Success', chains.basilisk, ([message]) => xcmpMessage === message.toHex())
        .then(({siblings}) => siblings.find(eventFilter('currencies.Deposited')));
    console.log('xcmp received', event.toHuman());
}

init().then(main).then(process.exit);



