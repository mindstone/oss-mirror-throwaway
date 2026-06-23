import { realFooProvider, setFooProvider } from '../../src/core/fooProvider';

const obj = { setFooProvider };
obj.setFooProvider(realFooProvider);
