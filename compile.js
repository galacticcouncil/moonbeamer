import solc from 'solc';
import fs from 'fs';

export function compile(filename) {
    const content = fs.readFileSync(filename, 'utf8');
    const input = {
        language: 'Solidity', sources: {
            [filename]: {
                content,
            },
        }, settings: {
            outputSelection: {
                '*': {
                    '*': ['*'],
                },
            },
        },
    };
    return JSON.parse(solc.compile(JSON.stringify(input)));
}

export function contracts(filename) {
    const res = compile(filename);
    return res.contracts[filename];
}