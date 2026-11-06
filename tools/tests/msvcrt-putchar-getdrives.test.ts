import {expect, test} from 'bun:test';
import {msvcrtModule} from '../../src/worker/api/msvcrt.api';

test('putchar and _getdrives are cdecl exports with their documented arity', () => {
    const putchar = msvcrtModule.functions.find(x => x.name === 'putchar');
    const getdrives = msvcrtModule.functions.find(x => x.name === '_getdrives');
    expect([putchar?.callingConvention, putchar?.params.length]).toEqual(['cdecl', 1]);
    expect([getdrives?.callingConvention, getdrives?.params.length]).toEqual(['cdecl', 0]);
});
