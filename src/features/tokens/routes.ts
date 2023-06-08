import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { TokenType } from '@hyperlane-xyz/hyperlane-token';

import { areAddressesEqual, isValidEvmAddress } from '../../utils/addresses';
import { logger } from '../../utils/logger';
import { getCaip2Id } from '../chains/caip2';
import { ProtocolType } from '../chains/types';
import { getMultiProvider, getProvider } from '../multiProvider';

import { AdapterFactory } from './adapters/AdapterFactory';
import { EvmTokenAdapter } from './adapters/EvmTokenAdapter';
import { ITokenAdapter } from './adapters/ITokenAdapter';
import { getHypErc20CollateralContract } from './contracts/evmContracts';
import { getAllTokens } from './metadata';
import { TokenMetadata, TokenMetadataWithHypTokens } from './types';

export enum RouteType {
  BaseToSynthetic = 'baseToSynthetic',
  SyntheticToSynthetic = 'syntheticToSynthetic',
  SyntheticToBase = 'syntheticToBase',
}

export interface Route {
  type: RouteType;
  baseCaip2Id: Caip2Id;
  baseTokenAddress: Address;
  tokenRouterAddress: Address;
  originTokenAddress: Address;
  destTokenAddress: Address;
  decimals: number;
}

// Origin chain to destination chain to Route
export type RoutesMap = Record<Caip2Id, Record<Caip2Id, Route[]>>;

export function useTokenRoutes() {
  const {
    isLoading,
    data: tokenRoutes,
    error,
  } = useQuery(
    ['token-routes'],
    async () => {
      logger.info('Searching for token routes');
      const tokens: TokenMetadataWithHypTokens[] = [];
      for (const token of getAllTokens()) {
        // Consider parallelizing here but concerned about RPC rate limits
        await validateTokenMetadata(token);
        const tokenWithHypTokens = await fetchRemoteHypTokens(token);
        tokens.push(tokenWithHypTokens);
      }
      return computeTokenRoutes(tokens);
    },
    { retry: false },
  );

  return { isLoading, error, tokenRoutes };
}

async function validateTokenMetadata(token: TokenMetadata) {
  const {
    type,
    caip2Id,
    symbol,
    decimals,
    tokenRouterAddress,
    protocol = ProtocolType.Ethereum,
  } = token;

  // Native tokens cannot be queried for metadata
  if (type !== TokenType.collateral) return;

  logger.info(`Validating token ${symbol} on ${caip2Id}`);

  let tokenAdapter: ITokenAdapter;
  if (protocol === ProtocolType.Ethereum) {
    const provider = getProvider(caip2Id);
    const collateralContract = getHypErc20CollateralContract(tokenRouterAddress, provider);
    const wrappedTokenAddr = await collateralContract.wrappedToken();
    tokenAdapter = new EvmTokenAdapter(provider, wrappedTokenAddr);
  } else if (protocol === ProtocolType.Sealevel) {
    // TODO solana support
    return;
  }

  const { decimals: decimalsOnChain, symbol: symbolOnChain } = await tokenAdapter!.getMetadata();
  if (decimals !== decimalsOnChain) {
    throw new Error(
      `Token config decimals ${decimals} does not match contract decimals ${decimalsOnChain}`,
    );
  }
  if (symbol !== symbolOnChain) {
    throw new Error(
      `Token config symbol ${symbol} does not match contract decimals ${symbolOnChain}`,
    );
  }
}

async function fetchRemoteHypTokens(
  originToken: TokenMetadata,
): Promise<TokenMetadataWithHypTokens> {
  const { caip2Id, symbol, tokenRouterAddress, protocol = ProtocolType.Ethereum } = originToken;
  logger.info(`Fetching remote tokens for ${symbol} on ${caip2Id}`);

  const hypTokenAdapter = AdapterFactory.CollateralAdapterFromAddress(caip2Id, tokenRouterAddress);

  const remoteRouters = await hypTokenAdapter!.getAllRouters();
  logger.info(`Router addresses found:`, remoteRouters);

  const multiProvider = getMultiProvider();
  const hypTokens = remoteRouters.map((router) => {
    const chainId = multiProvider.getChainId(router.domain);
    const caip2Id = getCaip2Id(protocol, chainId);
    return {
      address: router.address,
      caip2Id,
    };
  });
  return { ...originToken, hypTokens };
}

// Process token list to populates routesCache with all possible token routes (e.g. router pairs)
function computeTokenRoutes(tokens: TokenMetadataWithHypTokens[]) {
  const tokenRoutes: RoutesMap = {};

  // Instantiate map structure
  const allChainIds = getChainsFromTokens(tokens);
  for (const origin of allChainIds) {
    tokenRoutes[origin] = {};
    for (const dest of allChainIds) {
      if (origin === dest) continue;
      tokenRoutes[origin][dest] = [];
    }
  }

  // Compute all possible routes, in both directions
  for (const token of tokens) {
    for (const hypToken of token.hypTokens) {
      const {
        caip2Id: baseCaip2Id,
        address: baseTokenAddress,
        tokenRouterAddress,
        decimals,
      } = token;
      const { caip2Id: syntheticCaip2Id, address: hypTokenAddress } = hypToken;

      const commonRouteProps = {
        baseCaip2Id,
        baseTokenAddress,
        tokenRouterAddress,
      };
      tokenRoutes[baseCaip2Id][syntheticCaip2Id].push({
        type: RouteType.BaseToSynthetic,
        ...commonRouteProps,
        originTokenAddress: tokenRouterAddress,
        destTokenAddress: hypTokenAddress,
        decimals,
      });
      tokenRoutes[syntheticCaip2Id][baseCaip2Id].push({
        type: RouteType.SyntheticToBase,
        ...commonRouteProps,
        originTokenAddress: hypTokenAddress,
        destTokenAddress: tokenRouterAddress,
        decimals,
      });

      for (const otherHypToken of token.hypTokens) {
        // Skip if it's same hypToken as parent loop
        if (otherHypToken.caip2Id === syntheticCaip2Id) continue;
        const { caip2Id: otherSynCaip2Id, address: otherHypTokenAddress } = otherHypToken;
        tokenRoutes[syntheticCaip2Id][otherSynCaip2Id].push({
          type: RouteType.SyntheticToSynthetic,
          ...commonRouteProps,
          originTokenAddress: hypTokenAddress,
          destTokenAddress: otherHypTokenAddress,
          decimals,
        });
        tokenRoutes[otherSynCaip2Id][syntheticCaip2Id].push({
          type: RouteType.SyntheticToSynthetic,
          ...commonRouteProps,
          originTokenAddress: otherHypTokenAddress,
          destTokenAddress: hypTokenAddress,
          decimals,
        });
      }
    }
  }
  return tokenRoutes;
}

function getChainsFromTokens(tokens: TokenMetadataWithHypTokens[]): Caip2Id[] {
  const chains = new Set<Caip2Id>();
  for (const token of tokens) {
    chains.add(token.caip2Id);
    for (const hypToken of token.hypTokens) {
      chains.add(hypToken.caip2Id);
    }
  }
  return Array.from(chains);
}

export function getTokenRoutes(
  originCaip2Id: Caip2Id,
  destinationCaip2Id: Caip2Id,
  tokenRoutes: RoutesMap,
): Route[] {
  return tokenRoutes[originCaip2Id]?.[destinationCaip2Id] || [];
}

export function getTokenRoute(
  originCaip2Id: Caip2Id,
  destinationCaip2Id: Caip2Id,
  baseTokenAddress: Address,
  tokenRoutes: RoutesMap,
): Route | null {
  if (!isValidEvmAddress(baseTokenAddress)) return null;
  return (
    getTokenRoutes(originCaip2Id, destinationCaip2Id, tokenRoutes).find((r) =>
      areAddressesEqual(baseTokenAddress, r.baseTokenAddress),
    ) || null
  );
}

export function hasTokenRoute(
  originCaip2Id: Caip2Id,
  destinationCaip2Id: Caip2Id,
  baseTokenAddress: Address,
  tokenRoutes: RoutesMap,
): boolean {
  return !!getTokenRoute(originCaip2Id, destinationCaip2Id, baseTokenAddress, tokenRoutes);
}

export function useRouteChains(tokenRoutes: RoutesMap): Caip2Id[] {
  return useMemo(() => {
    const allCaip2Ids = Object.keys(tokenRoutes) as Caip2Id[];
    const collateralCaip2Ids = getAllTokens().map((t) => t.caip2Id);
    return allCaip2Ids.sort((c1, c2) => {
      // Surface collateral chains first
      if (collateralCaip2Ids.includes(c1) && !collateralCaip2Ids.includes(c2)) return -1;
      else if (!collateralCaip2Ids.includes(c1) && collateralCaip2Ids.includes(c2)) return 1;
      else return c1 > c2 ? 1 : -1;
    });
  }, [tokenRoutes]);
}
