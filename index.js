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
        name: 'moonbase-alpha', rpc: 'https://rpc.api.moonbase.moonbeam.network', chainId: 0x507,
    }, basilisk: {
        rpc: 'wss://rpc-01.basilisk-moonbase.hydradx.io',
    }
};

async function init() {
    console.log('connecting accounts');

    const api = await ApiPromise.create({provider: new WsProvider(chains.basilisk.rpc)});
    const keyring = new Keyring({type: 'sr25519'});
    const account = keyring.addFromUri(process.env.PHRASE);
    chains.basilisk = {...chains.basilisk, api, account, keyring};
    const balance = await freeTokenBalance(account.address, tokens.DEV);
    console.log(account.address, balance.toString());

    const provider = new ethers.providers.StaticJsonRpcProvider(chains.moonbeam.rpc, chains.moonbeam);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const {Xtokens: {abi}} = contracts('Xtokens.sol');
    const Xtokens = new ethers.Contract('0x0000000000000000000000000000000000000804', abi, wallet);
    const {address} = wallet;
    chains.moonbeam = {...chains.moonbeam, provider, wallet, Xtokens, abi};
    console.log(address, String(await provider.getBalance(address)));
}

async function freeTokenBalance(address, token) {
    const balance = await chains.basilisk.api.query.tokens.accounts(address, token.id.basilisk);
    return balance.free;
}

const waitForBalanceChange = (address, token) => new Promise(async resolve => {
    const old = await freeTokenBalance(address, token);
    chains.basilisk.api.query.tokens.accounts(address, token.id.basilisk, ({free}) => {
        if (!old.sub(free).isZero()) resolve(free);
    });
});

const onEvent = (event, callback) => chains.basilisk.api.query.system.events(events => events
    .filter(({event: {section, method}}) => event === `${section}.${method}`)
    .forEach(callback));

const waitFor = event => new Promise(resolve => onEvent(event, resolve));

async function transferToParachain({token, amount, to: {parachain, address}}) {
    const {Xtokens} = chains.moonbeam;
    const {api} = chains.basilisk;
    const destination = {
        parents: 1,
        interior: [
            hexFixLength(api.registry.createType('ParaId', parachain).toHex(), 40, true),
            u8aConcat(
                api.registry.createType('u8', 1).toU8a(),
                api.registry.createType('AccountId', address).toU8a(),
                api.registry.createType('u8', 0).toU8a())
        ]
    };
    return Xtokens.transfer(token.id.moonbase, amount, destination, '0xee6b2800');
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
    await Promise.all([
        tx.wait().then(() => console.log('sent')),
        waitFor('currencies.Deposited').then(() => console.log('received')),
        waitForBalanceChange(transfer.to.address, transfer.token).then(free => console.log('balance changed', free.toString()))
    ]);
}

init().then(main).then(process.exit);



