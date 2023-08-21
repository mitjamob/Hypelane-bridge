declare type Address = string;
declare type DomainId = number;
declare type ChainCaip2Id = `${string}:${string}`; // e.g. ethereum:1 or solana:mainnet-beta
declare type TokenCaip19Id = `${string}:${string}/${string}:${string}`; // e.g. ethereum:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f
