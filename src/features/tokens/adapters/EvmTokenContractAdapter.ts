/* eslint-disable @typescript-eslint/no-unused-vars */
import { BigNumber, PopulatedTransaction, Signer, providers } from 'ethers';

import type { ERC20Upgradeable, HypERC20 } from '@hyperlane-xyz/hyperlane-token';
import { utils } from '@hyperlane-xyz/utils';

import { normalizeEvmAddress } from '../../../utils/addresses';
import { getErc20Contract, getHypErc20CollateralContract } from '../contracts/evmContracts';

import { IHypTokenAdapter, ITokenAdapter } from './ITokenContractAdapter';

type SignerOrProvider = Signer | providers.Provider;

export class EvmNativeTokenAdapter implements ITokenAdapter {
  constructor(public readonly signerOrProvider: SignerOrProvider) {}

  async getBalance(address?: Address): Promise<string> {
    const balanceAddress = await this.resolveAddress(address);
    const balance = await this.signerOrProvider.getBalance(balanceAddress);
    return balance.toString();
  }

  async getMetadata(): Promise<{ decimals: number; symbol: string; name: string }> {
    throw new Error('Metadata not available to native tokens');
  }

  async prepareApproveTx(
    _recipient: Address,
    _amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    throw new Error('Approve not required for native tokens');
  }

  async prepareTransferTx(
    recipient: Address,
    amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    const value = BigNumber.from(amountOrId);
    return { tx: { value, to: recipient } };
  }

  protected resolveAddress(address?: Address): Address | Promise<Address> {
    if (address) return address;
    else if (Signer.isSigner(this.signerOrProvider)) {
      return this.signerOrProvider.getAddress();
    } else {
      throw new Error('No address provided');
    }
  }
}

export class EvmTokenAdapter<T extends ERC20Upgradeable = ERC20Upgradeable>
  extends EvmNativeTokenAdapter
  implements ITokenAdapter
{
  public readonly contract: T;

  constructor(
    public readonly signerOrProvider: SignerOrProvider,
    public readonly contractAddress: Address,
    // @ts-ignore Compiler not understanding that getErc20Contract is valid here
    contractFactory: (a: Address, s: SignerOrProvider) => T = getErc20Contract,
  ) {
    super(signerOrProvider);
    this.contract = contractFactory(contractAddress, signerOrProvider);
  }

  override async getBalance(address?: Address): Promise<string> {
    const balanceAddress = await this.resolveAddress(address);
    const balance = await this.contract.balanceOf(balanceAddress);
    return balance.toString();
  }

  override async getMetadata(): Promise<{ decimals: number; symbol: string; name: string }> {
    const [decimals, symbol, name] = await Promise.all([
      this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
    ]);
    return { decimals, symbol, name };
  }

  override async prepareApproveTx(
    recipient: Address,
    amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    const tx = await this.contract.populateTransaction.approve(recipient, amountOrId);
    return { tx };
  }

  override async prepareTransferTx(
    recipient: Address,
    amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    const tx = await this.contract.populateTransaction.transfer(recipient, amountOrId);
    return { tx };
  }
}

export class EvmHypTokenAdapter<T extends HypERC20 = HypERC20>
  extends EvmTokenAdapter<T>
  implements IHypTokenAdapter
{
  constructor(
    public readonly signerOrProvider: SignerOrProvider,
    public readonly contractAddress: Address,
    contractFactory: (a: Address, s: SignerOrProvider) => T,
  ) {
    super(signerOrProvider, contractAddress, contractFactory);
  }

  getDomains(): Promise<DomainId[]> {
    return this.contract.domains();
  }

  async getRouterAddress(domain: DomainId): Promise<Address> {
    const routerAddressesAsBytes32 = await this.contract.routers(domain);
    return normalizeEvmAddress(utils.bytes32ToAddress(routerAddressesAsBytes32));
  }

  async getAllRouters(): Promise<Array<{ domain: DomainId; address: Address }>> {
    const domains = await this.getDomains();
    const routers: Address[] = await Promise.all(domains.map((d) => this.getRouterAddress(d)));
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  async quoteGasPayment(destination: DomainId): Promise<string> {
    const gasPayment = await this.contract.quoteGasPayment(destination);
    return gasPayment.toString();
  }

  async prepareTransferRemoteTx(
    destination: DomainId,
    recipient: Address,
    amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    const tx = await this.contract.populateTransaction.transferRemote(
      destination,
      recipient,
      amountOrId,
    );
    return { tx };
  }
}

export class EvmHypTokenCollateralAdapter extends EvmHypTokenAdapter implements IHypTokenAdapter {
  constructor(
    public readonly signerOrProvider: SignerOrProvider,
    public readonly contractAddress: Address,
  ) {
    // @ts-ignore Workaround for lack of multiple inheritance in TS
    super(signerOrProvider, contractAddress, getHypErc20CollateralContract);
  }

  override async getMetadata(): Promise<{ decimals: number; symbol: string; name: string }> {
    throw new Error('Metadata not available for HypCollateral/HypNative contract.');
  }

  override async prepareApproveTx(
    _recipient: Address,
    _amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    throw new Error('Approve not applicable to HypCollateral/HypNative contract.');
  }

  override async prepareTransferTx(
    _recipient: Address,
    _amountOrId: string | number,
  ): Promise<{ tx: PopulatedTransaction }> {
    throw new Error('Local transfer not supported for HypCollateral/HypNative contract.');
  }
}
