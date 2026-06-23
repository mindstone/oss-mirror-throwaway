import { NULL_FOO, realFooProvider, setFooProvider } from '../../src/core/fooProvider';

const env = { X: false };
setFooProvider(env.X ? realFooProvider : NULL_FOO);
