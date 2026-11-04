"use client";

import * as React from "react";
import type { ControllerProps, FieldPath, FieldValues } from "react-hook-form";
import { Controller, FormProvider, useFormContext } from "react-hook-form";

import { cn } from "../lib";
import { Label } from "./label";

const Form = FormProvider;

type FormFieldContextValue<
	TFieldValues extends FieldValues = FieldValues,
	TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
	name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

const FormField = <
	TFieldValues extends FieldValues = FieldValues,
	TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
	...props
}: ControllerProps<TFieldValues, TName>) => {
	return (
		<FormFieldContext.Provider value={{ name: props.name }}>
			<Controller {...props} />
		</FormFieldContext.Provider>
	);
};

const useFormField = () => {
	const fieldContext = React.useContext(FormFieldContext);
	const itemContext = React.useContext(FormItemContext);
	const { getFieldState, formState } = useFormContext();

	const fieldState = getFieldState(fieldContext.name, formState);

	if (!fieldContext) {
		throw new Error("useFormField should be used within <FormField>");
	}

	const { id } = itemContext;

	return {
		id,
		name: fieldContext.name,
		formItemId: `${id}-form-item`,
		formDescriptionId: `${id}-form-item-description`,
		formMessageId: `${id}-form-item-message`,
		...fieldState,
	};
};

type FormItemContextValue = {
	id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

const FormItem = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
	const id = React.useId();

	return (
		<FormItemContext.Provider value={{ id }}>
			<div className={cn("space-y-1.5", className)} {...props} />
		</FormItemContext.Provider>
	);
};

const FormLabel = ({ className, ...props }: React.ComponentProps<typeof Label>) => {
	const { error, formItemId } = useFormField();

	return (
		<Label
			className={cn("font-medium block", error && "text-destructive", className)}
			htmlFor={formItemId}
			{...props}
		/>
	);
};

const FormControl = ({ children }: { children: React.ReactElement }) => {
	const { error, formItemId, formDescriptionId, formMessageId } = useFormField();

	return React.cloneElement(children, {
		id: formItemId,
		"aria-describedby": error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId,
		"aria-invalid": Boolean(error),
	} as React.HTMLAttributes<HTMLElement>);
};

const FormDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
	const { formDescriptionId } = useFormField();

	return (
		<p
			id={formDescriptionId}
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
};

const FormMessage = ({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLParagraphElement>) => {
	const { error, formMessageId } = useFormField();
	const body = error ? String(error?.message) : children;

	if (!body) {
		return null;
	}

	return (
		<p
			id={formMessageId}
			className={cn("font-normal text-sm text-destructive", className)}
			{...props}
		>
			{body}
		</p>
	);
};

export {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	useFormField,
};
