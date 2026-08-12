export type ModelMenuItem = {
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    vision: boolean;
};

export type ModelMenuProvider = {
    id: string;
    displayName: string;
    /** false → provider has no credentials configured (shown dimmed with a hint). */
    authOk: boolean;
    models: ModelMenuItem[];
};

export type ModelMenuData = {
    providers: ModelMenuProvider[];
};

/** Flat, selectable row the menu navigates. */
export type ModelMenuRow = {
    providerId: string;
    providerName: string;
    authOk: boolean;
    modelId: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    vision: boolean;
    key: string; // `${providerId}/${modelId}`
};
