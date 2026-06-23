import { NULL_FOO, realFooProvider, setFooProvider } from '../../src/core/fooProvider';

const maybeReal = process.env.REAL ? realFooProvider : undefined;

setFooProvider(maybeReal ?? NULL_FOO);
