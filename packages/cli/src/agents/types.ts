type Tool<Targs = Record<string, string>> = {
    name : string;
    description : string;
    exec : (args : Targs) => Promise<string>;
}

type readArgs = {
    file : string;
}

type writeArgs = {
    file : string;
    content : string;
}

export type { Tool, readArgs, writeArgs };
