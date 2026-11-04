"use client";

import { LanguagesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./dropdown-menu";

export type LocaleSwitchOption<Value extends string = string> = {
	value: Value;
	label: string;
};

export type LocaleSwitchProps<Value extends string = string> = {
	locales: readonly LocaleSwitchOption<Value>[];
	value: Value;
	onValueChange: (value: Value) => void | Promise<void>;
	label: string;
	className?: string;
};

export function LocaleSwitch<Value extends string = string>({
	locales,
	value,
	onValueChange,
	label,
	className,
}: LocaleSwitchProps<Value>) {
	const [selectedValue, setSelectedValue] = useState<Value>(value);

	useEffect(() => {
		setSelectedValue(value);
	}, [value]);

	if (locales.length <= 1) {
		return null;
	}

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger
				render={
					<Button variant="ghost" size="icon" aria-label={label} className={className}>
						<LanguagesIcon className="size-4" />
					</Button>
				}
			/>

			<DropdownMenuContent>
				<DropdownMenuRadioGroup
					value={selectedValue}
					onValueChange={(nextValue) => {
						const matchedLocale = locales.find((locale) => locale.value === nextValue);

						if (!matchedLocale) {
							return;
						}

						setSelectedValue(matchedLocale.value);
						void onValueChange(matchedLocale.value);
					}}
				>
					{locales.map((locale) => (
						<DropdownMenuRadioItem key={locale.value} value={locale.value}>
							{locale.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
