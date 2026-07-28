export type Tool<Targs = Record<string, string>> = {
    name : string;
    description : string;
    exec : (args : Targs) => Promise<string>;
}

export type ReadArgs = {
    file: string;
};

export type WriteArgs = {
    file: string;
    content: string;
};

export type AppendArgs = {
    file: string;
    content: string;
};

export type DeleteArgs = {
    file: string;
};

export type MkdirArgs = {
    dir: string;
};

export type LsArgs = {
    dir: string;
};

export type GlobArgs = {
    pattern: string;
};

export type FindArgs = {
    root: string;
    name: string;
};

export type RenameArgs = {
    from: string;
    to: string;
};

export type CopyArgs = {
    from: string;
    to: string;
};

export type EditArgs = {
    file: string;
    oldText: string;
    newText: string;
};

